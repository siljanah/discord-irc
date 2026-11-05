/* eslint-disable no-unused-expressions, prefer-arrow-callback */
import chai from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import irc from 'irc-upd';
import discord from 'discord.js';
import Bot from '../lib/bot';
import logger from '../lib/logger';
import createDiscordStub from './stubs/discord-stub';
import createWebhookStub from './stubs/webhook-stub';
import ClientStub from './stubs/irc-client-stub';
import config from './fixtures/single-test-config.json';

chai.should();
chai.use(sinonChai);

describe('Reactions from Discord', function () {
  const sandbox = sinon.createSandbox();
  // Wrapped in IRC colors like other nicks
  const reactor = '\u000302reactor\u000f';

  beforeEach(function () {
    sandbox.stub(logger, 'info');
    sandbox.stub(logger, 'debug');
    sandbox.stub(logger, 'warn');
    this.errorSpy = sandbox.stub(logger, 'error');
    irc.Client = ClientStub;
    discord.Client = createDiscordStub(sandbox.stub());
    discord.WebhookClient = createWebhookStub(sandbox.stub());
    ClientStub.prototype.say = sandbox.stub();

    this.createBot = (conf = {}) => {
      this.bot = new Bot({ ...config, ircReactions: true, ...conf });
      this.bot.connect();
      this.guild = this.bot.discord.guilds.cache.first();
    };
    this.createBot();

    this.user = { id: 'reactor id', username: 'reactor', partial: false };
    this.createReaction = (content = 'original message', emoji = { id: null, name: '👍' }) => ({
      partial: false,
      emoji,
      message: {
        partial: false,
        content,
        mentions: { users: [] },
        author: { username: 'origauthor', id: 'orig id' },
        attachments: new discord.Collection(),
        guild: this.guild,
        channel: { name: 'discord', id: '999' },
      },
    });
    this.react = (reaction = this.createReaction(), user = this.user) =>
      this.bot.sendReactionToIRC(reaction, user);
  });

  afterEach(function () {
    sandbox.restore();
  });

  it('should send reactions to IRC', async function () {
    await this.react();
    ClientStub.prototype.say.should.have.been.calledOnceWithExactly(
      '#irc',
      `* ${reactor} reacted 👍 to origauthor: original message`
    );
  });

  it('should be triggered by the messageReactionAdd event', async function () {
    const sendReaction = sandbox.stub(this.bot, 'sendReactionToIRC').resolves();
    const reaction = this.createReaction();
    this.bot.discord.emit('messageReactionAdd', reaction, this.user);
    sendReaction.should.have.been.calledOnceWithExactly(reaction, this.user);
  });

  it('should be off by default', function () {
    this.createBot({ ircReactions: undefined });
    const sendReaction = sandbox.stub(this.bot, 'sendReactionToIRC').resolves();
    this.bot.discord.emit('messageReactionAdd', this.createReaction(), this.user);
    sendReaction.should.not.have.been.called;
  });

  it('should log errors instead of crashing', async function () {
    const error = new Error('Unknown Message');
    sandbox.stub(this.bot, 'sendReactionToIRC').rejects(error);
    this.bot.discord.emit('messageReactionAdd', this.createReaction(), this.user);
    await Promise.resolve();
    await Promise.resolve();
    this.errorSpy.should.have.been.calledWith('Could not send reaction to IRC', error);
  });

  it('should show custom emoji by name', async function () {
    await this.react(this.createReaction('hi', { id: '123', name: 'pepe' }));
    ClientStub.prototype.say.should.have.been.calledWith('#irc', `* ${reactor} reacted :pepe: to origauthor: hi`);
  });

  it('should truncate long messages', async function () {
    const long = 'a'.repeat(60);
    await this.react(this.createReaction(long));
    ClientStub.prototype.say.should.have.been.calledWith(
      '#irc',
      `* ${reactor} reacted 👍 to origauthor: ${'a'.repeat(50)}...`
    );
  });

  it('should fetch partial reactions, users and messages', async function () {
    const full = this.createReaction('fetched message');
    const message = { partial: true, fetch: sandbox.stub().resolves(full.message) };
    const reaction = {
      partial: true,
      fetch: sandbox.stub().resolves({ ...full, message }),
    };
    const user = { partial: true, fetch: sandbox.stub().resolves(this.user) };
    await this.react(reaction, user);
    reaction.fetch.should.have.been.calledOnce;
    user.fetch.should.have.been.calledOnce;
    message.fetch.should.have.been.calledOnce;
    ClientStub.prototype.say.should.have.been.calledWith(
      '#irc',
      `* ${reactor} reacted 👍 to origauthor: fetched message`
    );
  });

  it('should ignore reactions from the bot itself', async function () {
    await this.react(this.createReaction(), { id: this.bot.discord.user.id, username: 'bot' });
    ClientStub.prototype.say.should.not.have.been.called;
  });

  it('should ignore reactions from ignored users', async function () {
    await this.react(this.createReaction(), { id: '4499', username: 'someone' });
    ClientStub.prototype.say.should.not.have.been.called;
  });

  it('should ignore reactions in channels that are not mapped', async function () {
    const reaction = this.createReaction();
    reaction.message.channel = { name: 'unmapped', id: '555' };
    await this.react(reaction);
    ClientStub.prototype.say.should.not.have.been.called;
  });

  it('should support a custom format', async function () {
    this.createBot({ format: { ircReaction: '{$nickname} reagoi {$emoji} viestiin "{$quotedText}"' } });
    await this.react();
    ClientStub.prototype.say.should.have.been.calledWith('#irc', 'reactor reagoi 👍 viestiin "original message"');
  });
});
