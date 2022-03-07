'use strict';
/**
 * Copyright 2013 j <j@mailb.org>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const {Buffer} = require('buffer');
const crypto = require('crypto');
const eejs = require('ep_etherpad-lite/node/eejs/');
const sessioninfos = require('ep_etherpad-lite/node/handler/PadMessageHandler').sessioninfos;
const stats = require('ep_etherpad-lite/node/stats');

let logger = {};
for (const level of ['debug', 'info', 'warn', 'error']) {
  logger[level] = console[level].bind(console, 'ep_webrtc:');
}

const settings = {
  // The defaults here are overridden by the values in the `ep_webrtc` object from `settings.json`.
  enabled: true,
  audio: {
    disabled: 'none',
  },
  video: {
    disabled: 'none',
    sizes: {large: 260, small: 160},
  },
  videoConstraints: {
    width: {ideal: 160},
    height: {ideal: 120},
  },
  iceServers: [{urls: ['stun:stun.l.google.com:19302']}],
  listenClass: null,
  moreInfoUrl: {},
};
let socketio;

const addContextToError = (err, pfx) => {
  const newErr = new Error(`${pfx}${err.message}`, {cause: err});
  if (Error.captureStackTrace) Error.captureStackTrace(newErr, addContextToError);
  // Check for https://github.com/tc39/proposal-error-cause support, available in Node.js >= v16.10.
  if (newErr.cause === err) return newErr;
  err.message = `${pfx}${err.message}`;
  return err;
};

// Copied from:
// https://github.com/ether/etherpad-lite/blob/f95b09e0b6752a0d226d58d8b246831164dc9533/src/node/handler/PadMessageHandler.js#L1411-L1420
const _getRoomSockets = (padId) => {
  const ns = socketio.sockets; // Default namespace.
  const adapter = ns.adapter;
  // We could call adapter.clients(), but that method is unnecessarily asynchronous. Replicate what
  // it does here, but synchronously to avoid a race condition. This code will have to change when
  // we update to socket.io v3.
  const room = adapter.rooms[padId];
  if (!room) return [];
  return Object.keys(room.sockets).map((id) => ns.connected[id]).filter((s) => s);
};

/**
 * Handles an RTC Message
 * @param socket The socket.io Socket object for the client that sent the message.
 * @param message the message from the client
 */
const handleRTCMessage = (socket, payload) => {
  const {[socket.id]: {author: userId, padId} = {}} = sessioninfos;
  // The handleMessage hook is executed asynchronously, so the user can disconnect between when the
  // message arrives at Etherpad and when this function is called.
  if (userId == null || padId == null) return;
  const msg = {
    type: 'COLLABROOM',
    data: {
      type: 'RTC_MESSAGE',
      payload: {
        from: userId,
        data: payload.data,
      },
    },
  };
  if (payload.to == null) {
    socket.to(padId).json.send(msg);
  } else {
    for (const socket of _getRoomSockets(padId)) {
      const session = sessioninfos[socket.id];
      if (session && session.author === payload.to) {
        socket.json.send(msg);
        break;
      }
    }
  }
};

// Make sure any updates to this are reflected in README
const statErrorNames = [
  'Abort',
  'Hardware',
  'NotFound',
  'Permission',
  'SecureConnection',
  'Unknown',
];

const handleErrorStatMessage = (statName) => {
  if (statErrorNames.includes(statName)) {
    stats.meter(`ep_webrtc_err_${statName}`).mark();
  } else {
    logger.warn(`Invalid ep_webrtc error stat: ${statName}`);
  }
};

const fetchJson = async (url, opts = {}) => {
  const c = new globalThis.AbortController();
  const t = setTimeout(() => c.abort(), 5000);
  let res;
  try {
    res = await globalThis.fetch(url, {signal: c.signal, ...opts});
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return await res.json();
};

exports.clientVars = async (hookName, {clientVars: {userId: authorId}}) => ({ep_webrtc: {
  ...settings,
  iceServers: await Promise.all(settings.iceServers.map(async (server) => {
    switch (server.credentialType) {
      case 'coturn ephemeral password': {
        const {lifetime = 60 * 60 * 12 /* seconds */} = server;
        const username = `${Math.floor(Date.now() / 1000) + lifetime}:${authorId}`;
        const hmac = crypto.createHmac('sha1', server.credential);
        hmac.update(username);
        const credential = hmac.digest('base64');
        return {urls: server.urls, username, credential};
      }
      case 'xirsys ephemeral credentials': {
        const {
          url,
          username,
          credential,
          lifetime: expire = 12 * 60 * 60, // seconds
          method = 'PUT',
          headers: h = {},
          jsonBody: b = {},
        } = server;
        // Can't set default values for the Content-Type and Authorization headers by using an
        // object literal with spread (e.g., `{'content-type': 'foo', ...h}`) because the Headers
        // constructor uses `.append()` internally instead of `.set()`. This matters if a header is
        // repeated multiple times by using different mixes of upper- and lower-case letters.
        const headers = new globalThis.Headers(h);
        if (!headers.has('content-type')) headers.set('content-type', 'application/json');
        if (username && !headers.has('authorization')) {
          headers.set('authorization',
              `Basic ${Buffer.from(`${username}:${credential}`).toString('base64')}`);
        }
        const body =
            JSON.stringify(b && typeof b === 'object' ? {format: 'urls', expire, ...b} : b);
        try {
          const {v, s} = await fetchJson(url, {method, headers, body});
          if (s !== 'ok') throw new Error(`API error: ${v}`);
          return v.iceServers;
        } catch (err) {
          const newErr = addContextToError(err, 'failed to get TURN credentials: ');
          logger.error(newErr.stack || newErr.toString());
          throw newErr;
        }
      }
      default: return server;
    }
  })),
}});

exports.handleMessage = async (hookName, {message, socket}) => {
  if (message.type === 'COLLABROOM' && message.data.type === 'RTC_MESSAGE') {
    handleRTCMessage(socket, message.data.payload);
    return [null];
  }
  if (message.type === 'STATS' && message.data.type === 'RTC_MESSAGE') {
    handleErrorStatMessage(message.data.statName);
    return [null];
  }
};

exports.init_ep_webrtc = async (hookName, {logger: l}) => {
  if (l != null) logger = l;
  // TODO: Remove this once all supported Node.js versions have the fetch API (added in Node.js
  // v17.5.0 behind the --experimental-fetch flag).
  if (!globalThis.fetch) {
    // eslint-disable-next-line node/no-unsupported-features/es-syntax -- https://github.com/mysticatea/eslint-plugin-node/issues/250
    const {default: fetch, Headers, Request, Response} = await import('node-fetch');
    Object.assign(globalThis, {fetch, Headers, Request, Response});
  }
  // TODO: Remove this once all supported Node.js versions have AbortController (>= v15.4.0).
  if (!globalThis.AbortController) {
    // eslint-disable-next-line node/no-unsupported-features/es-syntax -- https://github.com/mysticatea/eslint-plugin-node/issues/250
    globalThis.AbortController = (await import('abort-controller')).default;
  }
};

exports.setSocketIO = (hookName, {io}) => { socketio = io; };

exports.eejsBlock_mySettings = (hookName, context) => {
  context.content += eejs.require('./templates/settings.ejs', {
    audio_hard_disabled: settings.audio.disabled === 'hard',
    video_hard_disabled: settings.video.disabled === 'hard',
  }, module);
};

exports.eejsBlock_styles = (hookName, context) => {
  context.content += eejs.require('./templates/styles.html', {}, module);
};

exports.loadSettings = async (hookName, {settings: {ep_webrtc = {}}}) => {
  const isObj = (o) => o != null && typeof o === 'object' && !Array.isArray(o);
  const merge = (target, source) => {
    for (const [k, sv] of Object.entries(source)) {
      const tv = target[k];
      // The own-property check on the target prevents prototype pollution. (Prototype pollution
      // shouldn't be exploitable here because the source comes from admin-controlled settings.json,
      // but the check is added anyway to hopefully pacify static analysis tools.)
      if (Object.prototype.hasOwnProperty.call(target, k) && isObj(tv) && isObj(sv)) merge(tv, sv);
      else target[k] = sv;
    }
  };
  merge(settings, ep_webrtc);
  settings.configError = (() => {
    for (const k of ['audio', 'video']) {
      const {[k]: {disabled} = {}} = settings;
      if (disabled != null && !['none', 'hard', 'soft'].includes(disabled)) {
        logger.error(`Invalid value in settings.json for ep_webrtc.${k}.disabled`);
        return true;
      }
    }
    return false;
  })();
  logger.info('configured:', {
    ...settings,
    iceServers: settings.iceServers.map((s) => s.credential ? {...s, credential: '*****'} : s),
  });
};
