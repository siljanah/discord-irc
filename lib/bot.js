import _ from 'lodash';
import irc from 'irc-upd';
import discord from 'discord.js';
import logger from './logger';
import { ConfigurationError } from './errors';
import { validateChannelMapping } from './validators';
import { formatFromDiscordToIRC, formatFromIRCToDiscord } from './formatting';

// Usernames need to be between 2 and 32 characters for webhooks:
const USERNAME_MIN_LENGTH = 2;
const USERNAME_MAX_LENGTH = 32;

const REQUIRED_FIELDS = ['server', 'nickname', 'channelMapping', 'discordToken'];
const DEFAULT_NICK_COLORS = ['light_blue', 'dark_blue', 'light_red', 'dark_red', 'light_green',
  'dark_green', 'magenta', 'light_magenta', 'orange', 'yellow', 'cyan', 'light_cyan'];
const patternMatch = /{\$(.+?)}/g;

// Long messages are never split into parts shorter than this
const MIN_IRC_TEXT_LENGTH = 50;

// Reconnect delays grow exponentially from the first value up to the max
const RECONNECT_DELAY_MIN = 5 * 1000;
const RECONNECT_DELAY_MAX = 5 * 60 * 1000;
// Discord login errors that retrying won't fix
const FATAL_DISCORD_LOGIN_ERRORS = ['TokenInvalid', 'DisallowedIntents'];
// Gateway close codes with a known cause
const DISCORD_CLOSE_HINTS = {
  4004: 'the Discord token is invalid',
  4014: 'the Server Members and Message Content intents must be enabled in the Discord Developer Portal',
};

/**
 * An IRC bot, works as a middleman for all communication
 * @param {object} options - server, nickname, channelMapping, outgoingToken, incomingURL
 */
class Bot {
  constructor(options) {
    REQUIRED_FIELDS.forEach((field) => {
      if (!options[field]) {
        throw new ConfigurationError(`Missing configuration field ${field}`);
      }
    });

    validateChannelMapping(options.channelMapping);

    this.discord = new discord.Client({
      // GuildMembers and MessageContent are privileged intents and must be
      // enabled for the bot in the Discord Developer Portal.
      intents: [
        discord.GatewayIntentBits.Guilds,
        discord.GatewayIntentBits.GuildMembers,
        discord.GatewayIntentBits.GuildMessages,
        discord.GatewayIntentBits.MessageContent,
        discord.GatewayIntentBits.GuildMessageReactions,
      ],
      // Needed to receive reactions to messages that aren't cached
      partials: [discord.Partials.Message, discord.Partials.Reaction, discord.Partials.User],
      rest: { retries: 3 },
    });

    this.server = options.server;
    this.nickname = options.nickname;
    this.ircOptions = options.ircOptions;
    this.discordToken = options.discordToken;
    this.commandCharacters = options.commandCharacters || [];
    this.ircNickColor = options.ircNickColor !== false; // default to true
    this.ircNickColors = options.ircNickColors || DEFAULT_NICK_COLORS;
    this.parallelPingFix = options.parallelPingFix === true; // default: false
    this.channels = _.values(options.channelMapping);
    // true/false for all channels, or a list of IRC/Discord channels to enable them for
    if (Array.isArray(options.ircStatusNotices)) {
      this.ircStatusNoticeChannels = new Set(options.ircStatusNotices
        .map(c => String(c).toLowerCase()));
      this.ircStatusNotices = this.ircStatusNoticeChannels.size > 0;
    } else {
      this.ircStatusNotices = options.ircStatusNotices;
    }
    this.announceSelfJoin = options.announceSelfJoin;
    this.webhookOptions = options.webhooks;

    // Nicks to ignore
    this.ignoreUsers = options.ignoreUsers || {};
    this.ignoreUsers.irc = this.ignoreUsers.irc || [];
    this.ignoreUsers.discord = this.ignoreUsers.discord || [];
    this.ignoreUsers.discordIds = this.ignoreUsers.discordIds || [];

    // "{$keyName}" => "variableValue"
    // author/nickname: nickname of the user who sent the message
    // discordChannel: Discord channel (e.g. #general)
    // ircChannel: IRC channel (e.g. #irc)
    // text: the (appropriately formatted) message content
    this.format = options.format || {};

    // "{$keyName}" => "variableValue"
    // displayUsername: nickname with wrapped colors
    // attachmentURL: the URL of the attachment (only applicable in formatURLAttachment)
    this.formatIRCText = this.format.ircText || '<{$displayUsername}> {$text}';
    this.formatURLAttachment = this.format.urlAttachment || '<{$displayUsername}> {$attachmentURL}';

    // "{$keyName}" => "variableValue"
    // quotedText: start of the Discord message that was replied to
    // quotedAuthor: nickname of the author of the replied-to message
    // Appended to the IRC message when a Discord message is a reply.
    this.formatReplyQuote = this.format.replyQuote || '(re: {$quotedText})';
    // Max length of quotedText, 0 disables reply quotes
    this.replyQuoteLength = options.replyQuoteLength !== undefined ? options.replyQuoteLength : 50;

    // Send Discord reactions to IRC (off by default)
    this.ircReactions = options.ircReactions === true;
    // "{$keyName}" => "variableValue"
    // displayUsername/nickname: who reacted, emoji: the reaction,
    // quotedText/quotedAuthor: the message that was reacted to
    this.formatIRCReaction = this.format.ircReaction ||
      '* {$displayUsername} reacted {$emoji} to {$quotedAuthor}: {$quotedText}';

    // "{$keyName}" => "variableValue"
    // side: "Discord" or "IRC"
    if ('commandPrelude' in this.format) {
      this.formatCommandPrelude = this.format.commandPrelude;
    } else {
      this.formatCommandPrelude = 'Command sent from {$side} by {$nickname}:';
    }

    // "{$keyName}" => "variableValue"
    // withMentions: text with appropriate mentions reformatted
    this.formatDiscord = this.format.discord || '**<{$author}>** {$withMentions}';

    // "{$keyName} => "variableValue"
    // nickname: nickame of IRC message sender
    this.formatWebhookAvatarURL = this.format.webhookAvatarURL;

    // Keep track of { channel => [list, of, usernames] } for ircStatusNotices
    this.channelUsers = {};

    this.channelMapping = {};
    this.webhooks = {};

    // Remove channel passwords from the mapping and lowercase IRC channel names
    _.forOwn(options.channelMapping, (ircChan, discordChan) => {
      this.channelMapping[discordChan] = ircChan.split(' ')[0].toLowerCase();
    });

    this.invertedMapping = _.invert(this.channelMapping);

    this.disconnecting = false;
    this.ircReconnectAttempts = 0;
    this.ircReconnectTimer = null;
    this.discordLoginAttempts = 0;
    this.discordLoginTimer = null;
    this.discordReconnecting = false;

    if (this.ircStatusNoticeChannels) {
      const knownChannels = [
        ...Object.keys(this.channelMapping),
        ...Object.values(this.channelMapping)
      ].map(c => c.toLowerCase());
      this.ircStatusNoticeChannels.forEach((channel) => {
        if (!knownChannels.includes(channel)) {
          logger.warn(`ircStatusNotices channel ${channel} is not in the channelMapping`);
        }
      });
    }
    this.autoSendCommands = options.autoSendCommands || [];
  }

  connect() {
    logger.debug('Connecting to IRC and Discord');
    this.disconnecting = false;
    this.loginToDiscord();

    // Extract id and token from Webhook urls and connect.
    _.forOwn(this.webhookOptions, (url, channel) => {
      const [id, token] = url.split('/').slice(-2);
      const client = new discord.WebhookClient({ id, token });
      this.webhooks[channel] = {
        id,
        client
      };
    });

    const ircOptions = {
      userName: this.nickname,
      realName: this.nickname,
      channels: this.channels,
      floodProtection: true,
      floodProtectionDelay: 500,
      // Reconnects are handled by the bot (see scheduleIrcReconnect)
      retryCount: 0,
      autoRenick: true,
      // options specified in the configuration file override the above defaults
      ...this.ircOptions
    };

    // default encoding to UTF-8 so messages to Discord aren't corrupted
    if (!Object.prototype.hasOwnProperty.call(ircOptions, 'encoding')) {
      if (irc.canConvertEncoding()) {
        ircOptions.encoding = 'utf-8';
      } else {
        logger.warn('Cannot convert message encoding; you may encounter corrupted characters with non-English text.\n' +
          'For information on how to fix this, please see: https://github.com/Throne3d/node-irc#character-set-detection');
      }
    }

    this.ircClient = new irc.Client(this.server, this.nickname, ircOptions);
    this.attachListeners();
  }

  static reconnectDelay(attempt) {
    return Math.min(RECONNECT_DELAY_MIN * (2 ** attempt), RECONNECT_DELAY_MAX);
  }

  loginToDiscord() {
    let login;
    try {
      login = Promise.resolve(this.discord.login(this.discordToken));
    } catch (error) {
      login = Promise.reject(error);
    }
    return login
      .then(() => {
        this.discordLoginAttempts = 0;
      })
      .catch((error) => {
        if (this.disconnecting) return;
        if (FATAL_DISCORD_LOGIN_ERRORS.includes(error.code)) {
          logger.error('Could not log in to Discord, not retrying:', error);
          return;
        }
        const delay = Bot.reconnectDelay(this.discordLoginAttempts);
        this.discordLoginAttempts += 1;
        logger.error(`Could not log in to Discord, retrying in ${delay / 1000} seconds:`, error);
        this.discordLoginTimer = setTimeout(() => {
          this.discordLoginTimer = null;
          this.loginToDiscord();
        }, delay);
      });
  }

  // irc-upd gives up after retryCount attempts and emits 'abort',
  // after which we keep trying with a growing delay
  scheduleIrcReconnect() {
    if (this.disconnecting) return;
    const delay = Bot.reconnectDelay(this.ircReconnectAttempts);
    this.ircReconnectAttempts += 1;
    logger.warn(`Disconnected from IRC, reconnecting in ${delay / 1000} seconds`);
    clearTimeout(this.ircReconnectTimer);
    this.ircReconnectTimer = setTimeout(() => {
      this.ircReconnectTimer = null;
      logger.info('Reconnecting to IRC');
      this.ircClient.connect();
    }, delay);
  }

  disconnect() {
    this.disconnecting = true;
    clearTimeout(this.ircReconnectTimer);
    clearTimeout(this.discordLoginTimer);
    this.ircClient.disconnect();
    this.discord.destroy();
    Object.values(this.webhooks).forEach(x => x.client.destroy());
  }

  attachListeners() {
    this.discord.on('clientReady', () => {
      logger.info('Connected to Discord');
    });

    this.ircClient.on('registered', (message) => {
      logger.info('Connected to IRC');
      this.ircReconnectAttempts = 0;
      logger.debug('Registered event: ', message);
      this.autoSendCommands.forEach((element) => {
        this.ircClient.send(...element);
      });
    });

    this.ircClient.on('error', (error) => {
      logger.error('Received error event from IRC', error);
    });

    this.ircClient.on('netError', (error) => {
      logger.warn('IRC network error:', String(error));
    });

    this.ircClient.on('abort', () => this.scheduleIrcReconnect());

    this.discord.on('shardReconnecting', () => {
      if (!this.discordReconnecting) logger.info('Disconnected from Discord, reconnecting');
      this.discordReconnecting = true;
    });

    const onDiscordReconnected = () => {
      if (!this.discordReconnecting) return;
      this.discordReconnecting = false;
      logger.info('Reconnected to Discord');
    };
    this.discord.on('shardResume', onDiscordReconnected);
    this.discord.on('shardReady', onDiscordReconnected);

    this.discord.on('shardDisconnect', (event) => {
      // Only emitted when discord.js won't reconnect by itself
      const hint = DISCORD_CLOSE_HINTS[event.code];
      logger.error(`Discord connection closed and will not reconnect (code ${event.code})${hint ? `: ${hint}` : ''}`);
    });

    this.discord.on('shardError', (error) => {
      logger.error('Discord connection error', error);
    });

    this.discord.on('error', (error) => {
      logger.error('Received error event from Discord', error);
    });

    this.discord.on('warn', (warning) => {
      logger.warn('Received warn event from Discord', warning);
    });

    this.discord.on('messageReactionAdd', (reaction, user) => {
      if (!this.ircReactions) return;
      this.sendReactionToIRC(reaction, user).catch((error) => {
        logger.error('Could not send reaction to IRC', error);
      });
    });

    this.discord.on('messageCreate', (message) => {
      // Ignore bot messages and people leaving/joining
      this.sendToIRC(message);
    });

    this.ircClient.on('message', this.sendToDiscord.bind(this));

    this.ircClient.on('notice', (author, to, text) => {
      this.sendToDiscord(author, to, `*${text}*`);
    });

    this.ircClient.on('nick', (oldNick, newNick, channels) => {
      if (!this.ircStatusNotices) return;
      channels.forEach((channelName) => {
        const channel = channelName.toLowerCase();
        if (this.channelUsers[channel]) {
          if (this.channelUsers[channel].has(oldNick)) {
            this.channelUsers[channel].delete(oldNick);
            this.channelUsers[channel].add(newNick);
            this.sendStatusNotice(channel, `*${oldNick}* is now known as ${newNick}`);
          }
        } else {
          logger.warn(`No channelUsers found for ${channel} when ${oldNick} changed.`);
        }
      });
    });

    this.ircClient.on('join', (channelName, nick) => {
      logger.debug('Received join:', channelName, nick);
      if (!this.ircStatusNotices) return;
      if (nick === this.ircClient.nick && !this.announceSelfJoin) return;
      const channel = channelName.toLowerCase();
      // self-join is announced before names (which includes own nick)
      // so don't add nick to channelUsers
      if (nick !== this.ircClient.nick) this.channelUsers[channel].add(nick);
      this.sendStatusNotice(channel, `*${nick}* has joined the channel`);
    });

    this.ircClient.on('part', (channelName, nick, reason) => {
      logger.debug('Received part:', channelName, nick, reason);
      if (!this.ircStatusNotices) return;
      const channel = channelName.toLowerCase();
      // remove list of users when no longer in channel (as it will become out of date)
      if (nick === this.ircClient.nick) {
        logger.debug('Deleting channelUsers as bot parted:', channel);
        delete this.channelUsers[channel];
        return;
      }
      if (this.channelUsers[channel]) {
        this.channelUsers[channel].delete(nick);
      } else {
        logger.warn(`No channelUsers found for ${channel} when ${nick} parted.`);
      }
      this.sendStatusNotice(channel, `*${nick}* has left the channel (${reason})`);
    });

    this.ircClient.on('quit', (nick, reason, channels) => {
      logger.debug('Received quit:', nick, channels);
      if (!this.ircStatusNotices || nick === this.ircClient.nick) return;
      channels.forEach((channelName) => {
        const channel = channelName.toLowerCase();
        if (!this.channelUsers[channel]) {
          logger.warn(`No channelUsers found for ${channel} when ${nick} quit, ignoring.`);
          return;
        }
        if (!this.channelUsers[channel].delete(nick)) return;
        this.sendStatusNotice(channel, `*${nick}* has quit (${reason})`);
      });
    });

    this.ircClient.on('topic', (channelName, topic, nick, message) => {
      // irc-upd also emits 'topic' with the current topic when joining a
      // channel; only announce actual changes
      if (!message || message.command !== 'TOPIC') return;
      logger.debug('Received topic change:', channelName, topic, nick);
      if (!this.ircStatusNotices || this.ignoredIrcUser(nick)) return;
      const channel = channelName.toLowerCase();
      if (!topic) {
        this.sendStatusNotice(channel, `*${nick}* cleared the topic`);
        return;
      }
      // Break @everyone/@here and other mentions so a topic can't ping anyone
      const safeTopic = formatFromIRCToDiscord(topic).replace(/@/g, '@\u200B');
      this.sendStatusNotice(channel, `*${nick}* changed the topic to: ${safeTopic}`);
    });

    this.ircClient.on('names', (channelName, nicks) => {
      logger.debug('Received names:', channelName, nicks);
      if (!this.ircStatusNotices) return;
      const channel = channelName.toLowerCase();
      this.channelUsers[channel] = new Set(Object.keys(nicks));
    });

    this.ircClient.on('action', (author, to, text) => {
      this.sendToDiscord(author, to, `_${text}_`);
    });

    this.ircClient.on('invite', (channel, from) => {
      logger.debug('Received invite:', channel, from);
      if (!this.invertedMapping[channel]) {
        logger.debug('Channel not found in config, not joining:', channel);
      } else {
        this.ircClient.join(channel);
        logger.debug('Joining channel:', channel);
      }
    });

    if (logger.level === 'debug') {
      this.discord.on('debug', (message) => {
        logger.debug('Received debug event from Discord', message);
      });
    }
  }

  static getDiscordNicknameOnServer(user, guild) {
    if (guild) {
      const userDetails = guild.members.cache.get(user.id);
      if (userDetails) {
        return userDetails.nickname || user.globalName || user.username;
      }
    }
    return user.globalName || user.username;
  }

  parseText(message) {
    const text = message.mentions.users.reduce((content, mention) => {
      const displayName = Bot.getDiscordNicknameOnServer(mention, message.guild);
      const userMentionRegex = RegExp(`<@(&|!)?${mention.id}>`, 'g');
      return content.replace(userMentionRegex, `@${displayName}`);
    }, message.content);

    return text
      .replace(/\n|\r\n|\r/g, ' ')
      .replace(/<#(\d+)>/g, (match, channelId) => {
        const channel = this.discord.channels.cache.get(channelId);
        if (channel) return `#${channel.name}`;
        return '#deleted-channel';
      })
      .replace(/<@&(\d+)>/g, (match, roleId) => {
        const role = message.guild.roles.cache.get(roleId);
        if (role) return `@${role.name}`;
        return '@deleted-role';
      })
      .replace(/<a?(:\w+:)\d+>/g, (match, emoteName) => emoteName);
  }

  isCommandMessage(message) {
    return this.commandCharacters.some(prefix => message.startsWith(prefix));
  }

  ignoredIrcUser(user) {
    return this.ignoreUsers.irc.some(i => i.toLowerCase() === user.toLowerCase());
  }

  ignoredDiscordUser(discordUser) {
    const ignoredName = this.ignoreUsers.discord.some(
      i => i.toLowerCase() === discordUser.username.toLowerCase()
    );
    const ignoredId = this.ignoreUsers.discordIds.some(i => i === discordUser.id);
    return ignoredName || ignoredId;
  }

  static substitutePattern(message, patternMapping) {
    return message.replace(patternMatch, (match, varName) => patternMapping[varName] || match);
  }

  sendToIRC(message) {
    const { author } = message;
    // Ignore messages sent by the bot itself:
    if (this.isOwnDiscordUser(author)) return undefined;

    // Do not send to IRC if this user is on the ignore list.
    if (this.ignoredDiscordUser(author)) return undefined;

    const { channelName, ircChannel } = this.findIrcChannel(message.channel);
    if (!ircChannel) return undefined;

    if (this.replyQuoteLength > 0 && message.type === discord.MessageType.Reply &&
        message.reference && message.reference.messageId) {
      // Use the cached message if possible, so the message order is preserved
      const { messages } = message.channel;
      const cached = messages && messages.cache.get(message.reference.messageId);
      if (cached) {
        this.relayToIRC(message, ircChannel, channelName, cached);
        return undefined;
      }
      return message.fetchReference()
        .catch((error) => {
          logger.warn('Could not fetch the message being replied to', error);
          return null;
        })
        .then(referenced => this.relayToIRC(message, ircChannel, channelName, referenced));
    }

    this.relayToIRC(message, ircChannel, channelName, null);
    return undefined;
  }

  isOwnDiscordUser(user) {
    return user.id === this.discord.user.id ||
      Object.keys(this.webhooks).some(channel => this.webhooks[channel].id === user.id);
  }

  findIrcChannel(discordChannel) {
    const channelName = `#${discordChannel.name}`;
    const ircChannel = this.channelMapping[discordChannel.id] ||
      this.channelMapping[channelName];
    logger.debug('Channel Mapping', channelName, this.channelMapping[channelName]);
    return { channelName, ircChannel };
  }

  formatDisplayUsername(nickname) {
    let displayUsername = nickname;

    if (this.parallelPingFix) {
      // Prevent users of both IRC and Discord from
      // being mentioned in IRC when they talk in Discord.
      displayUsername = `${displayUsername.slice(0, 1)}\u200B${displayUsername.slice(1)}`;
    }

    if (this.ircNickColor) {
      const colorIndex = (nickname.charCodeAt(0) + nickname.length) % this.ircNickColors.length;
      displayUsername = irc.colors.wrap(this.ircNickColors[colorIndex], displayUsername);
    }
    return displayUsername;
  }

  // The start of a message, for showing which message was replied or reacted to
  quoteMessage(quoted, maxLength) {
    let quotedText = this.parseText(quoted).trim();
    if (!quotedText && quoted.attachments && quoted.attachments.size) {
      quotedText = quoted.attachments.first().name || quoted.attachments.first().url;
    }
    // Array.from splits by code point so emoji etc. aren't cut in half
    const chars = Array.from(quotedText);
    if (chars.length > maxLength) {
      quotedText = `${chars.slice(0, maxLength).join('').trimEnd()}...`;
    }
    return {
      quotedText: formatFromDiscordToIRC(quotedText),
      quotedAuthor: Bot.getDiscordNicknameOnServer(quoted.author, quoted.guild),
    };
  }

  buildReplyQuote(referenced) {
    return Bot.substitutePattern(
      this.formatReplyQuote,
      this.quoteMessage(referenced, this.replyQuoteLength)
    );
  }

  async sendReactionToIRC(reaction, user) {
    const fullReaction = reaction.partial ? await reaction.fetch() : reaction;
    const fullUser = user.partial ? await user.fetch() : user;
    const message = fullReaction.message.partial ?
      await fullReaction.message.fetch() : fullReaction.message;

    if (this.isOwnDiscordUser(fullUser) || this.ignoredDiscordUser(fullUser)) return;

    const { channelName, ircChannel } = this.findIrcChannel(message.channel);
    if (!ircChannel) return;

    const { emoji } = fullReaction;
    const nickname = Bot.getDiscordNicknameOnServer(fullUser, message.guild);
    const text = Bot.substitutePattern(this.formatIRCReaction, {
      author: nickname,
      nickname,
      displayUsername: this.formatDisplayUsername(nickname),
      // Custom emoji can't be shown on IRC, so use their :name:
      emoji: emoji.id ? `:${emoji.name}:` : emoji.name,
      discordChannel: channelName,
      ircChannel,
      ...this.quoteMessage(message, this.replyQuoteLength > 0 ? this.replyQuoteLength : 50),
    });
    logger.debug('Sending reaction to IRC', ircChannel, text);
    this.ircClient.say(ircChannel, text);
  }

  relayToIRC(message, ircChannel, channelName, referenced) {
    const { author } = message;
    const fromGuild = message.guild;
    const nickname = Bot.getDiscordNicknameOnServer(author, fromGuild);
    let text = this.parseText(message);
    const displayUsername = this.formatDisplayUsername(nickname);

    const patternMap = {
      author: nickname,
      nickname,
      displayUsername,
      text,
      discordChannel: channelName,
      ircChannel
    };

    if (this.isCommandMessage(text)) {
      patternMap.side = 'Discord';
      logger.debug('Sending command message to IRC', ircChannel, text);
      // if (prelude) this.ircClient.say(ircChannel, prelude);
      if (this.formatCommandPrelude) {
        const prelude = Bot.substitutePattern(this.formatCommandPrelude, patternMap);
        this.ircClient.say(ircChannel, prelude);
      }
      this.ircClient.say(ircChannel, text);
    } else {
      if (text !== '') {
        // Convert formatting
        text = formatFromDiscordToIRC(text);
        if (referenced) {
          text = `${text} ${this.buildReplyQuote(referenced)}`;
        }
        patternMap.text = text;

        // Split long messages ourselves so every line gets the nickname
        this.splitForIRC(ircChannel, this.formatIRCText, patternMap).forEach((line) => {
          logger.debug('Sending message to IRC', ircChannel, line);
          this.ircClient.say(ircChannel, line);
        });
      }

      if (message.attachments && message.attachments.size) {
        message.attachments.forEach((a) => {
          patternMap.attachmentURL = a.url;
          const urlMessage = Bot.substitutePattern(this.formatURLAttachment, patternMap);

          logger.debug('Sending attachment URL to IRC', ircChannel, urlMessage);
          this.ircClient.say(ircChannel, urlMessage);
        });
      }
    }
  }

  // Max bytes of message text in one PRIVMSG, calculated like irc-upd does
  ircMaxMessageLength(target) {
    const { maxLineLength, opt } = this.ircClient;
    if (!maxLineLength) return 450; // not registered yet, same fallback as irc-upd
    const messageSplit = (opt && opt.messageSplit) || 512;
    return Math.min(maxLineLength - target.length, messageSplit);
  }

  // Formats the message with the given format, splitting the text into
  // as many lines as needed to fit in IRC messages
  splitForIRC(ircChannel, format, patternMap) {
    if (!format.includes('{$text}')) return [Bot.substitutePattern(format, patternMap)];
    const overhead = Buffer.byteLength(
      Bot.substitutePattern(format, { ...patternMap, text: 'x' }),
      'utf8'
    ) - 1;
    const maxTextLength = Math.max(
      this.ircMaxMessageLength(ircChannel) - overhead,
      MIN_IRC_TEXT_LENGTH
    );
    return Bot.splitByBytes(patternMap.text, maxTextLength)
      .map(text => Bot.substitutePattern(format, { ...patternMap, text }));
  }

  // Splits text into parts of at most maxBytes UTF-8 bytes, at spaces when possible
  static splitByBytes(text, maxBytes) {
    const parts = [];
    let rest = text;
    while (Buffer.byteLength(rest, 'utf8') > maxBytes) {
      // Find how many characters fit, without cutting a character in half
      const chars = Array.from(rest);
      let cut = 0;
      let bytes = 0;
      for (let i = 0; i < chars.length; i += 1) {
        const charBytes = Buffer.byteLength(chars[i], 'utf8');
        if (bytes + charBytes > maxBytes) break;
        bytes += charBytes;
        cut += chars[i].length;
      }
      if (cut === 0) cut = chars[0].length;

      const space = rest.lastIndexOf(' ', cut);
      if (space > 0) {
        parts.push(rest.slice(0, space));
        rest = rest.slice(space + 1);
      } else {
        parts.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
    }
    if (rest.length > 0) parts.push(rest);
    return parts;
  }

  findDiscordChannel(ircChannel) {
    const discordChannelName = this.invertedMapping[ircChannel.toLowerCase()];
    if (discordChannelName) {
      // #channel -> channel before retrieving and select only text channels:
      let discordChannel = null;

      if (this.discord.channels.cache.has(discordChannelName)) {
        discordChannel = this.discord.channels.cache.get(discordChannelName);
      } else if (discordChannelName.startsWith('#')) {
        discordChannel = this.discord.channels.cache
          .filter(c => c.type === discord.ChannelType.GuildText)
          .find(c => c.name === discordChannelName.slice(1));
      }

      if (!discordChannel) {
        logger.info(
          'Tried to send a message to a channel the bot isn\'t in: ',
          discordChannelName
        );
        return null;
      }
      return discordChannel;
    }
    return null;
  }

  findWebhook(ircChannel) {
    const discordChannelName = this.invertedMapping[ircChannel.toLowerCase()];
    return discordChannelName && this.webhooks[discordChannelName];
  }

  getDiscordAvatar(nick, channel) {
    const guildMembers = this.findDiscordChannel(channel).guild.members.cache;
    const findByNicknameOrUsername = caseSensitive =>
      (member) => {
        const names = [member.nickname, member.user.globalName, member.user.username]
          .filter(Boolean);
        if (caseSensitive) return names.includes(nick);
        return names.some(name => Bot.caseComp(name, nick));
      };

    // Try to find exact matching case
    let users = guildMembers.filter(findByNicknameOrUsername(true));

    // Now let's search case insensitive.
    if (users.size === 0) {
      users = guildMembers.filter(findByNicknameOrUsername(false));
    }

    // No matching user or more than one => default avatar
    if (users && users.size === 1) {
      const url = users.first().user.avatarURL({ size: 128, extension: 'png' });
      if (url) return url;
    }

    // If there isn't a URL format, don't send an avatar at all
    if (this.formatWebhookAvatarURL) {
      return Bot.substitutePattern(this.formatWebhookAvatarURL, { nickname: nick });
    }
    return null;
  }

  // compare two strings case-insensitively
  // for discord mention matching
  static caseComp(str1, str2) {
    return str1.toUpperCase() === str2.toUpperCase();
  }

  // check if the first string starts with the second case-insensitively
  // for discord mention matching
  static caseStartsWith(str1, str2) {
    return str1.toUpperCase().startsWith(str2.toUpperCase());
  }

  sendToDiscord(author, channel, text) {
    const discordChannel = this.findDiscordChannel(channel);
    if (!discordChannel) return;

    // Do not send to Discord if this user is on the ignore list.
    if (this.ignoredIrcUser(author)) {
      return;
    }

    // Convert text formatting (bold, italics, underscore)
    const withFormat = formatFromIRCToDiscord(text);

    const patternMap = {
      author,
      nickname: author,
      displayUsername: author,
      text: withFormat,
      discordChannel: `#${discordChannel.name}`,
      ircChannel: channel
    };

    if (this.isCommandMessage(text)) {
      patternMap.side = 'IRC';
      logger.debug('Sending command message to Discord', `#${discordChannel.name}`, text);
      if (this.formatCommandPrelude) {
        const prelude = Bot.substitutePattern(this.formatCommandPrelude, patternMap);
        Bot.sendToChannel(discordChannel, prelude);
      }
      Bot.sendToChannel(discordChannel, text);
      return;
    }

    const { guild } = discordChannel;
    const withMentions = withFormat.replace(/@([^\s#]+)#(\d+)/g, (match, username, discriminator) => {
      // @username#1234 => mention
      // skips usernames including spaces for ease (they cannot include hashes)
      // checks case insensitively as Discord does
      const user = guild.members.cache.find(x =>
        Bot.caseComp(x.user.username, username)
        && x.user.discriminator === discriminator);
      if (user) return user;

      return match;
    }).replace(/^([^@\s:,]+)[:,]|@([^\s]+)/g, (match, startRef, atRef) => {
      const reference = startRef || atRef;

      // this preliminary stuff is ultimately unnecessary
      // but might save time over later more complicated calculations
      // @nickname => mention, case insensitively
      const nickUser = guild.members.cache.find(x =>
        x.nickname && Bot.caseComp(x.nickname, reference));
      if (nickUser) return nickUser;

      // @displayname => mention, case insensitively
      const globalNameUser = guild.members.cache.find(x =>
        x.user.globalName && Bot.caseComp(x.user.globalName, reference));
      if (globalNameUser) return globalNameUser;

      // @username => mention, case insensitively
      const user = guild.members.cache.find(x => Bot.caseComp(x.user.username, reference));
      if (user) return user;

      // @role => mention, case insensitively
      const role = guild.roles.cache.find(x => x.mentionable && Bot.caseComp(x.name, reference));
      if (role) return role;

      // No match found checking the whole word. Check for partial matches now instead.
      // @nameextra => [mention]extra, case insensitively, as Discord does
      // uses the longest match, and if there are two, whichever is a match by case
      let matchLength = 0;
      let bestMatch = null;
      let caseMatched = false;

      // check if a partial match is found in reference and if so update the match values
      const checkMatch = function (matchString, matchValue) {
        // if the matchString is longer than the current best and is a match
        // or if it's the same length but it matches by case unlike the current match
        // set the best match to this matchString and matchValue
        if ((matchString.length > matchLength && Bot.caseStartsWith(reference, matchString))
          || (matchString.length === matchLength && !caseMatched
              && reference.startsWith(matchString))) {
          matchLength = matchString.length;
          bestMatch = matchValue;
          caseMatched = reference.startsWith(matchString);
        }
      };

      // check users by nickname, display name and username
      guild.members.cache.forEach((member) => {
        [member.nickname, member.user.globalName, member.user.username].forEach((name) => {
          if (name) checkMatch(name, member);
        });
      });
      // check mentionable roles by visible name
      guild.roles.cache.forEach((member) => {
        if (!member.mentionable) return;
        checkMatch(member.name, member);
      });

      // if a partial match was found, return the match and the unmatched trailing characters
      if (bestMatch) return bestMatch.toString() + reference.substring(matchLength);

      return match;
    }).replace(/:(\w+):/g, (match, ident) => {
      // :emoji: => mention, case sensitively
      const emoji = guild.emojis.cache.find(x => x.name === ident && x.requiresColons);
      if (emoji) return emoji;

      return match;
    }).replace(/#([^\s#@'!?,.]+)/g, (match, channelName) => {
      // channel names can't contain spaces, #, @, ', !, ?, , or .
      // (based on brief testing. they also can't contain some other symbols,
      // but these seem likely to be common around channel references)

      // discord matches channel names case insensitively
      const chan = guild.channels.cache.find(x => Bot.caseComp(x.name, channelName));
      return chan || match;
    });

    // Webhooks first
    const webhook = this.findWebhook(channel);
    if (webhook) {
      logger.debug('Sending message to Discord via webhook', withMentions, channel, '->', `#${discordChannel.name}`);
      const permissions = discordChannel.permissionsFor(this.discord.user);
      let canPingEveryone = false;
      if (permissions) {
        canPingEveryone = permissions.has(discord.PermissionFlagsBits.MentionEveryone);
      }
      const avatarURL = this.getDiscordAvatar(author, channel);
      const username = _.padEnd(author.substring(0, USERNAME_MAX_LENGTH), USERNAME_MIN_LENGTH, '_');
      webhook.client.send({
        content: withMentions,
        username,
        avatarURL,
        allowedMentions: canPingEveryone ? undefined : { parse: ['users', 'roles'] },
      }).catch((error) => {
        logger.error('Could not send message to Discord via webhook', error);
      });
      return;
    }

    patternMap.withMentions = withMentions;

    // Add bold formatting:
    // Use custom formatting from config / default formatting with bold author
    const withAuthor = Bot.substitutePattern(this.formatDiscord, patternMap);
    logger.debug('Sending message to Discord', withAuthor, channel, '->', `#${discordChannel.name}`);
    Bot.sendToChannel(discordChannel, withAuthor);
  }

  // Whether join/part/quit/nick notices should be sent for this IRC channel
  statusNoticesEnabled(ircChannel) {
    if (!this.ircStatusNoticeChannels) return !!this.ircStatusNotices;
    const channel = ircChannel.toLowerCase();
    const discordChannel = this.invertedMapping[channel];
    return this.ircStatusNoticeChannels.has(channel) ||
      (!!discordChannel && this.ircStatusNoticeChannels.has(discordChannel.toLowerCase()));
  }

  sendStatusNotice(channel, text) {
    if (!this.statusNoticesEnabled(channel)) return;
    this.sendExactToDiscord(channel, text);
  }

  /* Sends a message to Discord exactly as it appears */
  sendExactToDiscord(channel, text) {
    const discordChannel = this.findDiscordChannel(channel);
    if (!discordChannel) return;

    logger.debug('Sending special message to Discord', text, channel, '->', `#${discordChannel.name}`);
    Bot.sendToChannel(discordChannel, text);
  }

  // Failed sends (missing permissions, Discord outages...) are logged instead
  // of becoming unhandled rejections, which would crash the process
  static sendToChannel(discordChannel, text) {
    const logError = (error) => {
      logger.error(`Could not send message to Discord channel #${discordChannel.name}`, error);
    };
    try {
      return Promise.resolve(discordChannel.send(text)).catch(logError);
    } catch (error) {
      logError(error);
      return Promise.resolve();
    }
  }
}

export default Bot;
