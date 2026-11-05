#!/usr/bin/env node

import { createBots } from './helpers';
import logger from './logger';

/* istanbul ignore next */
if (!module.parent) {
  // Last line of defense: log unexpected errors so they show up in the logs.
  // A rejected promise is logged and the bot keeps running, an uncaught
  // exception leaves the bot in an unknown state, so exit and let a process
  // manager (pm2, systemd...) restart it.
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection:', reason);
  });
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception, exiting:', error);
    process.exit(1);
  });
  require('./cli').default();
}

export default createBots;
