import { DsBot } from '../../bin/dsbot';
import { GeneralCommand } from '../dscommon';
import { CommandMessage } from 'discord.js-commando';
import { S2GameLobbyRepository } from '../../repository/S2GameLobbyRepository';
import { TextChannel, Message } from 'discord.js';
import { GameLobbyStatus } from '../../gametracker';
import { stripIndents } from 'common-tags';
import { sleep } from '../../helpers';
import { S2GameLobby } from '../../entity/S2GameLobby';

enum LobbyQueryMethod {
    LobbyHandle,
    DocumentLink,
    MapName,
    ModName,
    PlayerName,
    PlayerBattletag,
}

interface LobbyIdParams {
    regionId: number;
    bucketId: number;
    recordId: number;
}

interface MapOrModLinkParams {
    regionId: number;
    documentId: number;
}

interface PlayerBattleTagParams {
    name: string;
    discriminator: number;
}

interface LobbyQueryParams {
    method: LobbyQueryMethod;
    lobbyHandle?: LobbyIdParams;
    mapName?: string;
    documentLink?: MapOrModLinkParams;
    modName?: string;
    playerName?: string;
    playerBattletag?: PlayerBattleTagParams;
}

function parseQuery(query: string): LobbyQueryParams | string {
    const bnetLinkMatches = query.trim().match(/^battlenet::\/\/starcraft\/map\/(\d+)\/(\d+)$/);
    if (bnetLinkMatches) {
        return {
            method: LobbyQueryMethod.DocumentLink,
            documentLink: {
                regionId: Number(bnetLinkMatches[1]) | 0,
                documentId: Number(bnetLinkMatches[2]) | 0,
            },
        };
    }

    const matches = query.trim().match(/^\s*(\w+)\s+(.*)$/);
    if (!matches) {
        return 'Invalid query';
    }

    const [methodName, methodParam] = [matches[1].toLowerCase(), matches[2]];
    if (!methodParam.length) {
        return `Please specify the argument for a choosen query method`;
    }

    switch (methodName) {
        case 'id': {
            const m = methodParam.match(/^([\d+]\/[\d+]\/[\d+])$/i);
            if (!m) return `Lobby id must be in the format of \`{regionId}/{bucketId}/{recordId}\``;
            return {
                method: LobbyQueryMethod.LobbyHandle,
                lobbyHandle: {
                    regionId: Number(m[1]) | 0,
                    bucketId: Number(m[2]) | 0,
                    recordId: Number(m[3]) | 0,
                },
            };
        }

        case 'mod': {
            return {
                method: LobbyQueryMethod.MapName,
                mapName: methodParam,
            };
        }

        case 'mod': {
            return {
                method: LobbyQueryMethod.ModName,
                modName: methodParam,
            };
        }

        case 'player': {
            const m = methodParam.split('#').filter(x => x.length).map(x => x.trim());
            if (m.length === 1) {
                return {
                    method: LobbyQueryMethod.PlayerName,
                    playerName: m[0],
                };
            }
            else if (m.length === 2) {
                return {
                    method: LobbyQueryMethod.PlayerBattletag,
                    playerBattletag: {
                        name: m[0],
                        discriminator: Number(m[1]) | 0,
                    },
                };
            }
            else {
                return 'Player name must be in the format `Username` or `Username#1234`.';
            }
        }

        default: {
            return `Unknown query method`;
        }
    }
}

export class LobbyPublishCommand extends GeneralCommand {
    constructor(client: DsBot) {
        super(client, {
            name: 'lobby',
            description: '',
            guildOnly: true,
            argsType: 'single',
            throttling: {
                usages: 5,
                duration: 60,
            },
            examples: [
                '`.lobby battlenet:://starcraft/map/2/202155`',
                '`.lobby map Ice Baneling Escape - Cold Voyage`',
                '`.lobby mod Scion Custom Races (Mod)`',
                '`.lobby player Username`',
                '`.lobby player Username#1234`',
            ],
        });
    }

    public async exec(msg: CommandMessage, args: string) {
        const qparams = parseQuery(args);
        if (typeof qparams === 'string') {
            return msg.reply(qparams);
        }

        const tmpMessage = await msg.channel.send(`Looking for it, hold on.. if the lobby was just made public, it might take few seconds before it'll appear.`) as Message;

        let qb = this.conn.getCustomRepository(S2GameLobbyRepository)
            .createQueryBuilder('lobby')
            .andWhere('lobby.status = :status', { status: GameLobbyStatus.Open })
        ;

        switch (qparams.method) {
            case LobbyQueryMethod.LobbyHandle: {
                qb = this.conn.getCustomRepository(S2GameLobbyRepository)
                    .createQueryBuilder('lobby')
                ;
                qb.andWhere('', {
                    regionId: qparams.lobbyHandle.regionId,
                    bnetBucketId: qparams.lobbyHandle.bucketId,
                    bnetRecordId: qparams.lobbyHandle.recordId,
                });
                break;
            }

            case LobbyQueryMethod.DocumentLink: {
                qb.andWhere('lobby.regionId AND (lobby.mapBnetId = :documentId OR lobby.extModBnetId = :documentId)', {
                    regionId: qparams.documentLink.regionId,
                    documentId: qparams.documentLink.documentId,
                });
                break;
            }

            case LobbyQueryMethod.MapName: {
                qb.innerJoin('lobby.mapDocumentVersion', 'mapDocVer');
                qb.innerJoin('mapDocVer.document', 'mapDoc');
                qb.andWhere('mapDoc.name = :name', {
                    name: qparams.mapName,
                });
                break;
            }

            case LobbyQueryMethod.ModName: {
                qb.innerJoin('lobby.extModDocumentVersion', 'extModDocVer');
                qb.innerJoin('extModDocVer.document', 'extModDoc');
                qb.andWhere('extModDoc.name = :name', {
                    name: qparams.mapName,
                });
                break;
            }

            case LobbyQueryMethod.PlayerName: {
                qb.innerJoin('lobby.slots', 'slot');
                qb.andWhere(`slot.name = :name`, {
                    name: qparams.playerName,
                });
                break;
            }

            case LobbyQueryMethod.PlayerBattletag: {
                qb.innerJoin('lobby.slots', 'slot');
                qb.innerJoin('slot.profile', 'profile');
                qb.andWhere(`profile.name = :name AND profile.discriminator = :discriminator`, {
                    name: qparams.playerBattletag.name,
                    discriminator: qparams.playerBattletag.discriminator,
                });
                break;
            }
        }

        let results: S2GameLobby[];
        for (let i = 0; i < 20; i++) {
            results = await qb.getMany();
            if (results.length) {
                await this.tasks.lreporter.bindMessageWithLobby(tmpMessage, results[0].id);
                return [];
            }
            await sleep(1000);
        }

        return tmpMessage.edit('Couldn\'t find a public game lobby which meets the criteria. Try again?');
    }
}
