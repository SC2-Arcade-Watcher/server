import { User, TextChannel, Message, RichEmbed, RichEmbedOptions, Snowflake, DiscordAPIError, PartialTextBasedChannelFields, DMChannel } from 'discord.js';
import { BotTask, DiscordErrorCode, GeneralCommand, formatObjectAsMessage, ExtendedCommandInfo } from '../dscommon';
import { S2GameLobby } from '../../entity/S2GameLobby';
import { GameLobbyStatus, GameRegion } from '../../gametracker';
import { S2GameLobbySlot, S2GameLobbySlotKind } from '../../entity/S2GameLobbySlot';
import { sleep, sleepUnless } from '../../helpers';
import { logger, logIt } from '../../logger';
import { DsGameLobbySubscription } from '../../entity/DsGameLobbySubscription';
import { DsGameLobbyMessage } from '../../entity/DsGameLobbyMessage';
import { S2GameLobbyRepository } from '../../repository/S2GameLobbyRepository';
import deepEqual = require('deep-equal');

export interface DestChannelOpts {
    userId: string;
    guildId: string;
    channelId: string;
}

interface PostedGameLobby {
    // embed?: RichEmbedOptions;
    msg: DsGameLobbyMessage;
}

class TrackedGameLobby {
    candidates = new Set<DsGameLobbySubscription>();
    postedMessages = new Set<PostedGameLobby>();

    constructor (public lobby: S2GameLobby) {
    }

    updateInfo(newLobbyInfo: S2GameLobby) {
        const previousInfo = this.lobby;
        this.lobby = newLobbyInfo;
        if (previousInfo.createdAt?.getTime() !== newLobbyInfo.createdAt?.getTime()) return true;
        if (previousInfo.closedAt?.getTime() !== newLobbyInfo.closedAt?.getTime()) return true;
        if (previousInfo.status !== newLobbyInfo.status) return true;
        if (previousInfo.lobbyTitle !== newLobbyInfo.lobbyTitle) return true;
        if (previousInfo.hostName !== newLobbyInfo.hostName) return true;
        if (previousInfo.slotsHumansTaken !== newLobbyInfo.slotsHumansTaken) return true;
        if (previousInfo.slotsHumansTotal !== newLobbyInfo.slotsHumansTotal) return true;
        if (!deepEqual(previousInfo.slots, newLobbyInfo.slots)) return true;
        return false;
    }

    isClosedStatusConcluded() {
        if (this.lobby.status === GameLobbyStatus.Open) return false;
        const tdiff = Date.now() - this.lobby.closedAt.getTime();
        return tdiff > 30000;
    }
}

export class LobbyReporterTask extends BotTask {
    trackedLobbies = new Map<number, TrackedGameLobby>();
    trackRules = new Map<number, DsGameLobbySubscription>();

    async reloadSubscriptions() {
        this.trackRules.clear();
        for (const rule of await this.conn.getRepository(DsGameLobbySubscription).find({
            relations: ['region'],
            where: { enabled: true },
        })) {
            this.trackRules.set(rule.id, rule);
        }
    }

    async load() {
        await this.reloadSubscriptions();
        await this.restore();
        await this.flushMessages();

        setTimeout(this.update.bind(this), 1000).unref();
        setInterval(this.flushMessages.bind(this), 60000 * 3600).unref();
    }

    async unload() {
    }

    @logIt({
        resDump: true,
        level: 'verbose',
    })
    protected async flushMessages() {
        // FIXME:
        return;
        if (!await this.waitUntilReady()) return;
        const res = await this.conn.getRepository(DsGameLobbyMessage).delete([
            'updated_at < FROM_UNIXTIME(UNIX_TIMESTAMP()-3600*24)',
            'completed = true',
        ]);
        return res.affected;
    }

    @logIt({
        level: 'verbose',
    })
    protected async restore() {
        const lobbyMessages = await this.conn.getRepository(DsGameLobbyMessage)
            .createQueryBuilder('lmsg')
            .innerJoinAndSelect('lmsg.rule', 'rule')
            .innerJoinAndSelect('lmsg.lobby', 'lobby')
            .andWhere('lmsg.completed = false')
            .getMany()
        ;
        if (!lobbyMessages.length) return;

        const freshLobbyInfo = await this.conn.getCustomRepository(S2GameLobbyRepository)
            .prepareDetailedSelect()
            .andWhere('lobby.id IN (:trackedLobbies)', {
                'trackedLobbies': lobbyMessages.map(x => x.lobby.id),
            })
            .getMany()
        ;

        for (const lobbyInfo of freshLobbyInfo) {
            const trackedLobby = new TrackedGameLobby(lobbyInfo);
            this.trackedLobbies.set(lobbyInfo.id, trackedLobby);
        }

        for (const lobbyMsg of lobbyMessages) {
            const trackedLobby = this.trackedLobbies.get(lobbyMsg.lobby.id);
            trackedLobby.postedMessages.add({ msg: lobbyMsg });
            lobbyMsg.lobby = trackedLobby.lobby;
        }
    }

    async update() {
        this.running = true;
        while (await this.waitUntilReady()) {
            await this.updateTrackedLobbies();
            await this.discoverNewLobbies();
            await this.evaluateCandidates();

            await sleepUnless(1000, () => !this.client.doShutdown);
        }
        this.running = false;
    }

    postLobby(lobby: S2GameLobby) {
        // this.postLobbyMessage
    }

    @logIt({
        level: 'verbose',
    })
    protected async discoverNewLobbies() {
        const newLobbiesInfo = await this.conn.getCustomRepository(S2GameLobbyRepository)
            .prepareDetailedSelect()
            .andWhere('lobby.id NOT IN (:trackedLobbies)', { 'trackedLobbies': [0].concat(Array.from(this.trackedLobbies.keys())) })
            .andWhere('lobby.status = :status', { status: GameLobbyStatus.Open })
            .getMany()
        ;

        logger.verbose(`Newly discovered lobbies, count=${newLobbiesInfo.length}`);

        for (const s2gm of newLobbiesInfo) {
            const trackedLobby = new TrackedGameLobby(s2gm);
            this.trackedLobbies.set(s2gm.id, trackedLobby);

            for (const rule of this.trackRules.values()) {
                if (
                    (
                        (rule.isMapNameRegex && s2gm.mapDocumentVersion.document.name.match(new RegExp(rule.mapName, 'iu'))) ||
                        (rule.isMapNamePartial && s2gm.mapDocumentVersion.document.name.toLowerCase().indexOf(rule.mapName.toLowerCase()) !== -1) ||
                        (!rule.isMapNameRegex && !rule.isMapNamePartial && s2gm.mapDocumentVersion.document.name.toLowerCase() === rule.mapName.toLowerCase())
                    ) &&
                    (!rule.variant || rule.variant === s2gm.mapVariantMode) &&
                    (!rule.region || rule.region.id === s2gm.region.id)
                ) {
                    trackedLobby.candidates.add(rule);
                }
            }

            if (trackedLobby.candidates.size > 0) {
                logger.info(`New lobby ${s2gm.region.code}#${s2gm.bnetRecordId} for "${s2gm.mapDocumentVersion.document.name}". Matching rules=${trackedLobby.candidates.size}`);
            }
        }
    }

    protected async evaluateCandidates() {
        const pendingCandidates = Array.from(this.trackedLobbies.entries()).filter(([lobId, trackedLobby]) => {
            return this.trackedLobbies.get(lobId).candidates.size > 0;
        });
        if (!pendingCandidates.length) return;

        logger.verbose(`Pending candidates, count=${pendingCandidates.length}`);
        await Promise.all(pendingCandidates.map(async ([lobId, trackedLobby]) => {
            const trackLob = this.trackedLobbies.get(lobId);
            for (const currCand of trackedLobby.candidates) {
                const timeDiff = (Date.now() - trackLob.lobby.createdAt.getTime()) / 1000;
                const humanOccupiedSlots = trackLob.lobby.getSlots({ kinds: [S2GameLobbySlotKind.Human] });
                if (
                    (currCand.timeDelay && currCand.timeDelay > timeDiff) &&
                    (currCand.humanSlotsMin && currCand.humanSlotsMin > humanOccupiedSlots.length)
                ) {
                    continue;
                }
                const result = await this.postSubscribedLobby(trackedLobby, currCand);
                if (result !== false) {
                    trackedLobby.candidates.delete(currCand);
                }
            }
        }));
    }

    @logIt({
        level: 'verbose',
    })
    protected async updateTrackedLobbies() {
        if (!this.trackedLobbies.size) return;

        // filter to only those which have been already posted
        // or have a matching subscription which did not yet meet its critera
        const trackedLobbiesRelevant = Array.from(this.trackedLobbies.values())
            .filter(x => x.postedMessages.size > 0 || x.candidates.size > 0)
        ;

        // fetch only IDs of lobbies which have newer data
        const affectedLobIds: number[] = [];
        const lobbyDataSnapshot = await this.conn.getCustomRepository(S2GameLobbyRepository)
            .createQueryBuilder('lobby')
            .select(['lobby.id', 'lobby.status', 'lobby.snapshotUpdatedAt', 'lobby.slotsUpdatedAt'])
            .andWhere('lobby.id IN (:trackedLobbies)', { 'trackedLobbies': trackedLobbiesRelevant.map(x => x.lobby.id) })
            .getMany()
        ;
        for (const lsnapshot of lobbyDataSnapshot) {
            const lobby = this.trackedLobbies.get(lsnapshot.id).lobby;
            if (
                lobby.status !== lsnapshot.status ||
                lobby.snapshotUpdatedAt?.getTime() !== lsnapshot.snapshotUpdatedAt?.getTime() ||
                lobby.slotsUpdatedAt?.getTime() !== lsnapshot.slotsUpdatedAt?.getTime()
            ) {
                affectedLobIds.push(lsnapshot.id);
            }
        }

        // also include closed lobbies which have't actually changed but require update of a post for other reasons
        // such as deleting messages after X seconds from when they've been orginally closed
        const outdatedLobIds = affectedLobIds.concat(
            trackedLobbiesRelevant.filter(x => x.postedMessages.size > 0 && x.isClosedStatusConcluded()).map(x => x.lobby.id)
        );

        logger.verbose(`Lobbies: affected count=${affectedLobIds.length}, outdated count=${outdatedLobIds.length}`);
        if (!outdatedLobIds.length) return;

        const freshLobbyInfo = await this.conn.getCustomRepository(S2GameLobbyRepository)
            .prepareDetailedSelect()
            .andWhere('lobby.id IN (:trackedLobbies)', {
                'trackedLobbies': Array.from(new Set(outdatedLobIds))
            })
            .getMany()
        ;
        let updateCount = 0;
        await Promise.all(freshLobbyInfo.map(async lobbyInfo => {
            const trackedLobby = this.trackedLobbies.get(lobbyInfo.id);
            const needsUpdate = trackedLobby.updateInfo(lobbyInfo);
            if (trackedLobby.postedMessages.size) {
                if (needsUpdate || trackedLobby.isClosedStatusConcluded()) {
                    ++updateCount;
                    await this.updateLobbyMessage(trackedLobby);
                }
                if (!trackedLobby.postedMessages.size) {
                    logger.debug(`Stopped tracking ${lobbyInfo.region.code}#${lobbyInfo.bnetRecordId} candidates=${trackedLobby.candidates.size}`);
                }
            }
            if (lobbyInfo.status !== GameLobbyStatus.Open) {
                this.trackedLobbies.delete(lobbyInfo.id);
            }
        }));
        logger.verbose(`Updated tracked lobbies count=${updateCount}`);
    }

    protected async fetchDestChannel(opts: DestChannelOpts): Promise<TextChannel | DMChannel> {
        if (opts.userId) {
            try {
                const destUser = await this.client.fetchUser(opts.userId);
                return destUser.dmChannel ?? (destUser.createDM());
            }
            catch (err) {
                if (err instanceof DiscordAPIError) {
                    // DiscordErrorCode.UnknownUser
                    // DiscordErrorCode.CannotSendMessagesToThisUser (??)
                    logger.error(`Couldn't create DM for an user, id=${opts.userId}`, err);
                }
                else {
                    throw err;
                }
            }
        }
        else if (opts.guildId) {
            const destGuild = this.client.guilds.get(opts.guildId);
            if (!destGuild) {
                logger.error(`Guild doesn't exist, id=${opts.guildId}`, opts);
                return;
            }

            const destGuildChan = destGuild.channels.get(opts.channelId);
            if (!destGuildChan) {
                logger.error(`Guild chan doesn't exist, id=${opts.channelId}`, opts);
                return;
            }
            if (!(destGuildChan instanceof TextChannel)) {
                logger.error(`Guild chan incorrect type=${destGuildChan.type}`, opts);
                return;
            }

            return destGuildChan;
        }
        else {
            throw new Error(`invalid DestChannelOpts`);
        }
    }

    protected async postSubscribedLobby(trackedLobby: TrackedGameLobby, rule: DsGameLobbySubscription) {
        let chan: TextChannel | DMChannel;
        chan = await this.fetchDestChannel(rule);
        if (!chan) {
            logger.warn(`Couldn't fetch the channel, deleting subscription, id=${rule.id}`);
            await this.conn.getRepository(DsGameLobbySubscription).update(rule.id, { enabled: false });
            this.trackRules.delete(rule.id);
            return;
        }
        return this.postTrackedLobby(chan, trackedLobby, rule);
    }

    @logIt({
        argsDump: (trackedLobby: TrackedGameLobby) => [
            trackedLobby.lobby.id,
            trackedLobby.lobby.mapDocumentVersion.document.name,
            trackedLobby.lobby.hostName,
            trackedLobby.lobby.slotsHumansTaken,
            trackedLobby.lobby.slots.length
        ],
        level: 'debug',
    })
    async postTrackedLobby(chan: TextChannel | DMChannel, trackedLobby: TrackedGameLobby, subscription?: DsGameLobbySubscription) {
        const gameLobMessage = new DsGameLobbyMessage();
        gameLobMessage.lobby = trackedLobby.lobby;
        gameLobMessage.rule = subscription ?? null;
        const lbEmbed = embedGameLobby(trackedLobby.lobby, subscription);

        try {
            const msg = await chan.send('', { embed: lbEmbed }) as Message;
            gameLobMessage.messageId = msg.id;
        }
        catch (err) {
            if (err instanceof DiscordAPIError) {
                if (subscription && (err.code === DiscordErrorCode.MissingPermissions || err.code === DiscordErrorCode.MissingAccess)) {
                    logger.error(`Failed to send message for lobby #${trackedLobby.lobby.id}, rule #${subscription.id}`, err.message);
                    const tdiff = Date.now() - subscription.createdAt.getTime();
                    if (tdiff >= 1000 * 60 * 10) {
                        logger.info(`Deleting rule #${subscription.id}`);
                        await this.conn.getRepository(DsGameLobbySubscription).update(subscription.id, { enabled: false });
                        this.trackRules.delete(subscription.id);
                    }
                    else {
                        logger.info(`Deleting rule #${subscription.id}`);
                        return false;
                    }
                }
                else {
                    logger.error(`Failed to send message for lobby #${trackedLobby.lobby.id}`, err, lbEmbed, subscription, trackedLobby.lobby);
                }
                return;
            }
            else {
                throw err;
            }
        }

        if (chan instanceof TextChannel) {
            gameLobMessage.guildId = chan.guild.id;
        }
        else if (chan instanceof DMChannel) {
            gameLobMessage.userId = chan.recipient.id;
        }
        else {
            throw new Error(`unsupported channel type=${(<any>chan).type}`);
        }
        gameLobMessage.channelId = chan.id;
        await this.conn.getRepository(DsGameLobbyMessage).insert(gameLobMessage);
        trackedLobby.postedMessages.add({ msg: gameLobMessage, });

        return true;
    }

    async bindMessageWithLobby(msg: Message, lobbyId: number) {
        let trackedLobby = this.trackedLobbies.get(lobbyId);
        if (!trackedLobby) {
            const lobby = await this.conn.getCustomRepository(S2GameLobbyRepository)
                .prepareDetailedSelect()
                .getOne()
            ;
            if (!lobby) return;

            trackedLobby = this.trackedLobbies.get(lobbyId);
            if (!trackedLobby) {
                trackedLobby = new TrackedGameLobby(lobby);
                this.trackedLobbies.set(lobby.id, trackedLobby);
            }
        }

        const chan = msg.channel;
        const gameLobMessage = new DsGameLobbyMessage();
        gameLobMessage.messageId = msg.id;
        gameLobMessage.lobby = trackedLobby.lobby;
        if (chan instanceof TextChannel) {
            gameLobMessage.guildId = chan.guild.id;
        }
        else if (chan instanceof DMChannel) {
            gameLobMessage.userId = chan.recipient.id;
        }
        else {
            throw new Error(`unsupported channel type=${chan.type}`);
        }
        gameLobMessage.channelId = chan.id;
        await this.conn.getRepository(DsGameLobbyMessage).insert(gameLobMessage);

        const lobbyMsg: PostedGameLobby = { msg: gameLobMessage };
        trackedLobby.postedMessages.add(lobbyMsg);
        await this.editLobbyMessage(trackedLobby, lobbyMsg);

        return trackedLobby;
    }

    protected async releaseLobbyMessage(trackedLobby: TrackedGameLobby, lobbyMsg: PostedGameLobby) {
        await this.conn.getRepository(DsGameLobbyMessage).update(lobbyMsg.msg.id, { updatedAt: new Date(), completed: true });
        trackedLobby.postedMessages.delete(lobbyMsg);
    }

    protected async editLobbyMessage(trackedLobby: TrackedGameLobby, lobbyMsg: PostedGameLobby) {
        const lbEmbed = embedGameLobby(trackedLobby.lobby, lobbyMsg.msg.rule);
        try {
            const chan = await this.fetchDestChannel(lobbyMsg.msg);
            if (!chan) {
                await this.releaseLobbyMessage(trackedLobby, lobbyMsg);
                return;
            }
            const msg = await chan.fetchMessage(lobbyMsg.msg.messageId);
            if (!msg) {
                await this.releaseLobbyMessage(trackedLobby, lobbyMsg);
                return;
            }

            await msg.edit('', { embed: lbEmbed });
            if (
                lobbyMsg.msg.rule &&
                (trackedLobby.lobby.status === GameLobbyStatus.Started && lobbyMsg.msg.rule.deleteMessageStarted) ||
                (trackedLobby.lobby.status === GameLobbyStatus.Abandoned && lobbyMsg.msg.rule.deleteMessageDisbanded) ||
                (trackedLobby.lobby.status === GameLobbyStatus.Unknown && lobbyMsg.msg.rule.deleteMessageDisbanded)
            ) {
                if (trackedLobby.isClosedStatusConcluded()) {
                    try {
                        await msg.delete();
                        await this.releaseLobbyMessage(trackedLobby, lobbyMsg);
                    }
                    catch (err) {
                        if (err instanceof DiscordAPIError) {
                            if (err.code === DiscordErrorCode.UnknownMessage) {
                                await this.releaseLobbyMessage(trackedLobby, lobbyMsg);
                                return;
                            }
                            logger.error(`Failed to delete`, err);
                        }
                        else {
                            throw err;
                        }
                    }
                }
            }
            else if (trackedLobby.lobby.status !== GameLobbyStatus.Open) {
                await this.releaseLobbyMessage(trackedLobby, lobbyMsg);
            }
        }
        catch (err) {
            if (err instanceof DiscordAPIError) {
                if (err.code === DiscordErrorCode.UnknownMessage || err.code === DiscordErrorCode.MissingAccess) {
                    await this.releaseLobbyMessage(trackedLobby, lobbyMsg);
                    return;
                }
                logger.error(`Failed to update message for lobby #${trackedLobby.lobby.id}, msgid=${lobbyMsg.msg.messageId}`, err, lbEmbed, lobbyMsg.msg);
            }
            else {
                throw err;
            }
        }
    }

    @logIt({
        argsDump: (trackedLobby: TrackedGameLobby) => [
            trackedLobby.lobby.id,
            trackedLobby.lobby.mapDocumentVersion.document.name,
            trackedLobby.lobby.hostName,
            trackedLobby.lobby.slotsHumansTaken,
            trackedLobby.lobby.slots.length
        ],
        level: 'debug',
    })
    protected async updateLobbyMessage(trackedLobby: TrackedGameLobby) {
        const pendingPosts: Promise<void>[] = [];
        for (const lobbyMsg of trackedLobby.postedMessages) {
            pendingPosts.push(this.editLobbyMessage(trackedLobby, lobbyMsg));
        }
        await Promise.all(pendingPosts);
    }
}

function formatTimeDiff(a: Date, b: Date) {
    const secsDiff = Math.max(((a.getTime() - b.getTime()) / 1000), 0.0);
    return `${(Math.floor(secsDiff / 60)).toFixed(0).padStart(2, '0')}:${Math.floor(secsDiff % 60).toFixed(0).padStart(2, '0')}`;
}

function embedGameLobby(s2gm: S2GameLobby, cfg?: { showLeavers: boolean }): RichEmbedOptions {
    if (!cfg) {
        cfg = {
            showLeavers: false,
        };
    }

    // battlenet:://starcraft/map/${s2gm.region.id}/${s2gm.mapDocumentVersion.document.bnetId}
    const em: RichEmbedOptions = {
        title: `${s2gm.mapDocumentVersion.document.name}`,
        fields: [],
        thumbnail: {
            url: `http://sc2arcade.talv.space/bnet/${s2gm.mapDocumentVersion.iconHash}.jpg`,
        },
        timestamp: s2gm.createdAt,
        footer: {
            text: `${s2gm.region.code}#${s2gm.bnetRecordId}`,
        },
    };

    switch (s2gm.region.id) {
        case GameRegion.US: {
            em.footer.icon_url = 'https://i.imgur.com/K584M0K.png';
            break;
        }
        case GameRegion.EU: {
            em.footer.icon_url = 'https://i.imgur.com/G8Vst8Q.png';
            break;
        }
        case GameRegion.KR: {
            em.footer.icon_url = 'https://i.imgur.com/YbFsB42.png';
            break;
        }
    }

    let statusm: string[] = [];
    switch (s2gm.status) {
        case GameLobbyStatus.Open: {
            statusm.push('⏳');
            em.color = 0xffac33;
            break;
        }
        case GameLobbyStatus.Started: {
            statusm.push('✅');
            em.color = 0x77b255;
            break;
        }
        case GameLobbyStatus.Abandoned: {
            statusm.push('❌');
            em.color = 0xdd2e44;
            break;
        }
        case GameLobbyStatus.Unknown: {
            statusm.push('❓');
            em.color = 0xccd6dd;
            break;
        }
    }
    statusm.push(` __** ${s2gm.status.toLocaleUpperCase()} **__`);
    if (s2gm.status !== GameLobbyStatus.Open) {
        statusm.push(` \`${formatTimeDiff(s2gm.closedAt, s2gm.createdAt)}\``);
    }

    em.fields.push({
        name: `Status`,
        value: statusm.join(''),
        inline: true,
    });

    if (s2gm.extModDocumentVersion) {
        em.fields.push({
            name: `Extension mod`,
            value: `${s2gm.extModDocumentVersion.document.name}`,
            inline: true,
        });
    }
    else if (s2gm.mapVariantMode.trim().length) {
        em.fields.push({
            name: `Variant`,
            value: `${s2gm.mapVariantMode}`,
            inline: true,
        });
    }

    if (s2gm.lobbyTitle) {
        em.fields.push({
            name: `Title`,
            value: s2gm.lobbyTitle,
            inline: false,
        });
    }

    const teamsNumber = (new Set(s2gm.slots.map(x => x.team))).size;
    const activeSlots = s2gm.slots.filter(x => x.kind !== S2GameLobbySlotKind.Open).sort((a, b) => b.slotKindPriority - a.slotKindPriority);
    const humanSlots = s2gm.slots.filter(x => x.kind === S2GameLobbySlotKind.Human);

    function formatSlotRows(slotsList: S2GameLobbySlot[], opts: { includeTeamNumber?: boolean } = {}) {
        const ps: string[] = [];
        let i = 1;
        for (const slot of slotsList) {
            const wparts: string[] = [];
            wparts.push(`\`${i.toString().padStart(slotsList.length.toString().length, '0')})`);

            if (
                opts.includeTeamNumber &&
                (slot.kind === S2GameLobbySlotKind.Human || slot.kind === S2GameLobbySlotKind.AI)
            ) {
                wparts.push(` T${slot.team}`);
            }

            if (slot.kind === S2GameLobbySlotKind.Human) {
                let fullname = slot.profile ? `${slot.profile.name}#${slot.profile.discriminator}` : slot.name;

                wparts.push(` ${formatTimeDiff(slot.joinInfo?.joinedAt ?? s2gm.slotsUpdatedAt, s2gm.createdAt)}\``);

                // force monospace font on KR to fit more characters in the same line
                if (s2gm.regionId === 3) {
                    fullname = `\`${fullname}\``;
                    wparts.push(` ${fullname === s2gm.hostName ? `__${fullname}__` : `${fullname}`} `);
                }
                else {
                    wparts.push(` ${fullname === s2gm.hostName ? `__**${fullname}**__` : `**${fullname}**`}`);
                }
            }
            else if (slot.kind === S2GameLobbySlotKind.AI) {
                wparts.push(`  AI  \``);
            }
            else if (slot.kind === S2GameLobbySlotKind.Open) {
                wparts.push(` OPEN \``);
            }
            ps.push(wparts.join(''));
            ++i;
        }
        return ps;
    }

    if ((s2gm.status === GameLobbyStatus.Open || s2gm.status === GameLobbyStatus.Started) && activeSlots.length) {
        let teamSizes: number[] = [];
        for (const slot of s2gm.slots) {
            if (!teamSizes[slot.team]) teamSizes[slot.team] = 0;
            teamSizes[slot.team] += 1;
        }
        teamSizes = teamSizes.filter(x => typeof x === 'number');

        const useRichLayout = (
            (teamsNumber >= 2 && s2gm.slots.length / teamsNumber >= 2) &&
            (Math.max(...teamSizes) <= 6)
        );

        if (useRichLayout) {
            for (let currTeam = 1; currTeam <= teamsNumber; currTeam++) {
                const currTeamSlots = s2gm.getSlots({ teams: [currTeam] }).sort((a, b) => b.slotKindPriority - a.slotKindPriority);
                if (!currTeamSlots.length) continue;
                const currTeamOccupied = s2gm.getSlots({ kinds: [S2GameLobbySlotKind.Human, S2GameLobbySlotKind.AI], teams: [currTeam] });
                const formattedSlots = formatSlotRows(currTeamSlots);

                if (!em.fields.find(x => x.name === 'Title')) {
                    em.fields.find(x => x.name === 'Variant' || x.name === 'Extension mod').inline = false;
                }
                em.fields.push({
                    // name: `Team ${currTeam} [${currTeamOccupied.length}/${currTeamSlots.length}]`,
                    name: `Team ${currTeam}`,
                    value: formattedSlots.join('\n'),
                    inline: true,
                });
                if ((currTeam % 2) === 0 && teamsNumber > currTeam) {
                    em.fields.push({ name: `\u200B`, value: `\u200B`, inline: false, });
                }
            }
        }
        else {
            const occupiedSlots = s2gm.getSlots({ kinds: [S2GameLobbySlotKind.Human, S2GameLobbySlotKind.AI] });
            const formattedSlots = formatSlotRows(occupiedSlots, {
                includeTeamNumber: teamsNumber > 1 && Math.max(...teamSizes) > 1,
            });
            em.fields.push({
                name: `Players [${occupiedSlots.length}/${s2gm.slots.length}]`,
                value: formattedSlots.join('\n'),
                inline: false,
            });
        }
    }

    let leftPlayers = s2gm.getLeavers();
    if (cfg.showLeavers || s2gm.status === GameLobbyStatus.Open) {
        if (!cfg.showLeavers) {
            leftPlayers = leftPlayers.filter(x => (Date.now() - x.leftAt.getTime()) <= 40000);
        }
        if (leftPlayers.length) {
            const ps: string[] = [];
            for (const joinInfo of leftPlayers) {
                ps.push([
                    `\`${formatTimeDiff(joinInfo.joinedAt, s2gm.createdAt)} >`,
                    ` ${formatTimeDiff(joinInfo.leftAt, s2gm.createdAt)}\` `,
                    ` ~~${joinInfo.profile.name}#${joinInfo.profile.discriminator}~~`,
                ].join(''));
            }

            while (ps.join('\n').length > 1024) {
                ps.splice(0, 1);
            }

            em.fields.push({
                name: `Seen players [${leftPlayers.length}]`,
                value: ps.join('\n'),
                inline: false,
            });
        }
    }

    return em;
}
