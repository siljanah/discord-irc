/* eslint-disable class-methods-use-this */
import events from 'events';
import sinon from 'sinon';
import discord from 'discord.js';

export default function createDiscordStub(sendStub) {
  return class DiscordStub extends events.EventEmitter {
    constructor() {
      super();
      this.user = {
        id: 'testid'
      };
      this.options = discord.Options.createDefault();
      this.channels = new discord.ChannelManager(this, []);

      this.users = new discord.UserManager(this, []);
      this.guilds = new discord.GuildManager(this, []);
      const guild = this.createGuildStub();
      this.guilds.cache.set(guild.id, guild);

      this.rest = this.createRestStub();
    }

    destroy() {}

    addTextChannel(guild, textChannel) {
      const textChannelData = {
        type: discord.ChannelType.GuildText,
        ...textChannel
      };
      const textChannelObj = new discord.TextChannel(guild, textChannelData, this);
      textChannelObj.send = sendStub;
      const permissions = new discord.Collection();
      textChannelObj.setPermissionStub = (user, perms) => permissions.set(user, perms);
      textChannelObj.permissionsFor = user => permissions.get(user);
      this.channels.cache.set(textChannelObj.id, textChannelObj);
      return textChannelObj;
    }

    createGuildStub(guildData = {}) {
      const guild = {
        id: '1',
        client: this,
        addTextChannel: (textChannel) => {
          const textChannelObj = this.addTextChannel(guild, textChannel);
          textChannelObj.guild.channels.cache.set(textChannelObj.id, textChannelObj);
          return textChannelObj;
        }
      };
      guild.roles = new discord.RoleManager(guild, []);
      guild.members = new discord.GuildMemberManager(guild, []);
      guild.members.fetch = sinon.stub().callsFake(() => Promise.resolve(guild.members.cache));
      guild.emojis = new discord.GuildEmojiManager(guild, []);
      guild.channels = new discord.GuildChannelManager(guild, []);
      Object.assign(guild, guildData);
      this.guilds.cache.set(guild.id, guild);

      if (guild.id === '1') {
        guild.addTextChannel({
          name: 'discord',
          id: '1234',
        });
      }

      return guild;
    }

    createRestStub() {
      return {
        cdn: new discord.CDN(),
      };
    }

    login() {
      return sinon.stub();
    }
  };
}
