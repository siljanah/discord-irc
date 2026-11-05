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

describe('Reconnecting and error handling', function () {
  const sandbox = sinon.createSandbox();

  beforeEach(function () {
    this.clock = sandbox.useFakeTimers();
    this.infoSpy = sandbox.stub(logger, 'info');
    this.debugSpy = sandbox.stub(logger, 'debug');
    this.warnSpy = sandbox.stub(logger, 'warn');
    this.errorSpy = sandbox.stub(logger, 'error');
    this.sendStub = sandbox.stub();
    irc.Client = ClientStub;
    discord.Client = createDiscordStub(this.sendStub);
    discord.WebhookClient = createWebhookStub(sandbox.stub());
    ClientStub.prototype.send = sandbox.stub();
    ClientStub.prototype.connect = sandbox.stub();
    this.loginStub = sandbox.stub().resolves('token');
    discord.Client.prototype.login = this.loginStub;
    this.bot = new Bot(config);
    this.bot.connect();
  });

  afterEach(function () {
    sandbox.restore();
  });

  it('should grow the reconnect delay up to five minutes', function () {
    Bot.reconnectDelay(0).should.equal(5000);
    Bot.reconnectDelay(1).should.equal(10000);
    Bot.reconnectDelay(2).should.equal(20000);
    Bot.reconnectDelay(10).should.equal(300000);
  });

  it('should let the bot handle IRC reconnects', function () {
    const bot = new Bot(config);
    let ircOptions;
    irc.Client = function (server, nick, opts) {
      ircOptions = opts;
      return new ClientStub(server, nick, opts);
    };
    bot.connect();
    ircOptions.retryCount.should.equal(0);
    bot.disconnect();
  });

  context('IRC', function () {
    it('should reconnect after the connection is lost', function () {
      this.bot.ircClient.emit('abort', 0);
      this.warnSpy.should.have.been.calledWith('Disconnected from IRC, reconnecting in 5 seconds');
      ClientStub.prototype.connect.should.not.have.been.called;
      this.clock.tick(5000);
      ClientStub.prototype.connect.should.have.been.calledOnce;
    });

    it('should keep trying with a growing delay', function () {
      this.bot.ircClient.emit('abort', 0);
      this.clock.tick(5000);
      this.bot.ircClient.emit('abort', 0);
      this.warnSpy.should.have.been.calledWith('Disconnected from IRC, reconnecting in 10 seconds');
      this.clock.tick(9999);
      ClientStub.prototype.connect.should.have.been.calledOnce;
      this.clock.tick(1);
      ClientStub.prototype.connect.should.have.been.calledTwice;
    });

    it('should reset the delay after a successful connection', function () {
      this.bot.ircClient.emit('abort', 0);
      this.clock.tick(5000);
      this.bot.ircClient.emit('abort', 0);
      this.clock.tick(10000);
      this.bot.ircClient.emit('registered', {});
      this.bot.ircClient.emit('abort', 0);
      this.warnSpy.lastCall.should.have.been.calledWith('Disconnected from IRC, reconnecting in 5 seconds');
    });

    it('should not reconnect after disconnect() was called', function () {
      this.bot.ircClient.emit('abort', 0);
      this.bot.disconnect();
      this.clock.tick(10 * 60 * 1000);
      ClientStub.prototype.connect.should.not.have.been.called;
      this.bot.ircClient.emit('abort', 0);
      this.clock.tick(10 * 60 * 1000);
      ClientStub.prototype.connect.should.not.have.been.called;
    });

    it('should log network errors', function () {
      this.bot.ircClient.emit('netError', new Error('ECONNRESET'));
      this.warnSpy.should.have.been.calledWith('IRC network error:', 'Error: ECONNRESET');
    });
  });

  context('Discord login', function () {
    it('should retry a failed login with a growing delay', async function () {
      const error = new Error('getaddrinfo ENOTFOUND discord.com');
      this.loginStub.resetHistory();
      this.loginStub.onFirstCall().rejects(error);
      this.loginStub.onSecondCall().rejects(error);
      await this.bot.loginToDiscord();
      this.errorSpy.should.have.been.calledWith('Could not log in to Discord, retrying in 5 seconds:', error);
      await this.clock.tickAsync(5000);
      this.loginStub.should.have.been.calledTwice;
      this.errorSpy.should.have.been.calledWith('Could not log in to Discord, retrying in 10 seconds:', error);
      await this.clock.tickAsync(10000);
      this.loginStub.should.have.been.calledThrice;
      this.bot.discordLoginAttempts.should.equal(0);
    });

    it('should not retry when the token is invalid', async function () {
      const error = new Error('An invalid token was provided.');
      error.code = 'TokenInvalid';
      this.loginStub.resetHistory();
      this.loginStub.rejects(error);
      await this.bot.loginToDiscord();
      this.errorSpy.should.have.been.calledWith('Could not log in to Discord, not retrying:', error);
      await this.clock.tickAsync(10 * 60 * 1000);
      this.loginStub.should.have.been.calledOnce;
    });

    it('should not retry after disconnect() was called', async function () {
      this.loginStub.resetHistory();
      this.loginStub.rejects(new Error('fail'));
      const login = this.bot.loginToDiscord();
      this.bot.disconnect();
      await login;
      await this.clock.tickAsync(10 * 60 * 1000);
      this.loginStub.should.have.been.calledOnce;
    });
  });

  context('Discord connection events', function () {
    it('should log reconnects once', function () {
      this.bot.discord.emit('shardReconnecting', 0);
      this.bot.discord.emit('shardReconnecting', 0);
      this.bot.discord.emit('shardResume', 0, 5);
      this.bot.discord.emit('shardResume', 0, 5);
      this.infoSpy.withArgs('Disconnected from Discord, reconnecting').should.have.been.calledOnce;
      this.infoSpy.withArgs('Reconnected to Discord').should.have.been.calledOnce;
    });

    it('should log a reconnect that needed a new session', function () {
      this.bot.discord.emit('shardReconnecting', 0);
      this.bot.discord.emit('shardReady', 0);
      this.infoSpy.should.have.been.calledWith('Reconnected to Discord');
    });

    it('should explain unrecoverable disconnects', function () {
      this.bot.discord.emit('shardDisconnect', { code: 4014 }, 0);
      this.errorSpy.should.have.been.calledWith(
        'Discord connection closed and will not reconnect (code 4014): ' +
        'the Server Members and Message Content intents must be enabled in the Discord Developer Portal'
      );
    });

    it('should log connection errors', function () {
      const error = new Error('socket hang up');
      this.bot.discord.emit('shardError', error, 0);
      this.errorSpy.should.have.been.calledWith('Discord connection error', error);
    });
  });

  context('sending to Discord', function () {
    it('should log failed sends instead of crashing', async function () {
      const error = new Error('Missing Permissions');
      this.sendStub.rejects(error);
      this.bot.sendExactToDiscord('#irc', 'hello');
      await Promise.resolve();
      await Promise.resolve();
      this.errorSpy.should.have.been.calledWith('Could not send message to Discord channel #discord', error);
    });

    it('should log sends that throw synchronously', function () {
      const error = new Error('boom');
      this.sendStub.throws(error);
      this.bot.sendToDiscord('nick', '#irc', 'hello');
      this.errorSpy.should.have.been.calledWith('Could not send message to Discord channel #discord', error);
    });
  });
});
