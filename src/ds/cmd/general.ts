import { DsBot } from '../../bin/dsbot';
import { GeneralCommand } from '../dscommon';
import { CommandMessage } from 'discord.js-commando';

export class InviteCommand extends GeneralCommand {
    constructor(client: DsBot) {
        super(client, {
            name: 'invite',
            description: 'Generate an invitation link, allowing you to add the bot to ',
        });
    }

    public async exec(msg: CommandMessage) {
        return msg.reply(`<https://discord.com/oauth2/authorize?client_id=${this.client.user.id}&scope=bot&permissions=379968>`);
    }
}
