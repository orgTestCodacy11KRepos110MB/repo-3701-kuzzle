/*
 * Kuzzle, a backend software, self-hostable and ready to use
 * to power modern apps
 *
 * Copyright 2015-2020 Kuzzle
 * mailto: support AT kuzzle.io
 * website: http://kuzzle.io
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const querystring = require('querystring');
const url = require('url');
const zlib = require('zlib');

const uWS = require('uWebSockets.js');

const { Request } = require('../../../api/request');
const { KuzzleError } = require('../../../kerror/errors');
const Protocol = require('./protocol');
const ClientConnection = require('../clientConnection');
const removeErrorStack = require('../removeErrorStack');
const debug = require('../../../util/debug');
const kerror = require('../../../kerror');
const HttpMessage = require('./httpMessage');

const kerrorWS = kerror.wrap('network', 'websocket');
const kerrorHTTP = kerror.wrap('network', 'http');
const debugWS = debug('kuzzle:network:protocols:websocket');
const debugHTTP = debug('kuzzle:network:protocols:http');

// The idleTimeout option should never be deactivated, so instead we use
// a default value for backward-compatibility
const DEFAULT_IDLE_TIMEOUT = 60000;

// Size (in bytes) of backpressure an individual socket can handle before
// needing to drain
const WS_PER_SOCKET_BACKPRESSURE_BUFFER_SIZE = 4096;

// Size of the backpressure buffer: if a client is too slow to absorb the amount
// of data we need to send to it, then we forcibly close its socket to prevent
// the server to be impacted by it
const WS_BACKPRESSURE_BUFFER_MAX_LENGTH = 50;

// Applicative WebSocket PONG message for browsers
const WS_APP_PONG_RESPONSE = Buffer.from('{"p":2}');

// Used by the broadcast method to build JSON payloads while limiting the
// number of JSON serializations
const JSON_ROOM_PROPERTY = ',"room":"';
const JSON_ENDER = '"}';

// Pre-computed messages & errors
const WS_FORCED_TERMINATION_CODE = 1011;
const WS_BACKPRESSURE_MESSAGE = Buffer.from('too much backpressure: client is too slow');
const WS_GENERIC_CLOSE_MESSAGE = Buffer.from('Connection closed by remote host');
const WS_RATE_LIMIT_EXCEEDED_ERROR = kerrorWS.get('ratelimit_exceeded');
const HTTP_REQUEST_TOO_LARGE_ERROR = kerrorHTTP.get('request_too_large');
const HTTP_FILE_TOO_LARGE_ERROR = kerrorHTTP.get('file_too_large');

// HTTP-related constants
const HTTP_ALLOWED_CONTENT_TYPES = [
  'application/json',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
];
const HTTP_HEADER_CONTENT_LENGTH = Buffer.from('Content-Length');
const CHARSET_REGEX = /charset=([\w-]+)/i;

/**
 * @class HTTPWS
 * Handles both HTTP and WebSocket connections
 */
class HttpWsProtocol extends Protocol {
  constructor () {
    super('websocket');

    this.server = null;
    this.wsConfig = null;
    this.httpConfig = null;

    // Used to limit the rate of messages on websocket
    this.now = Date.now();
    this.nowInterval = setInterval(() => {
      this.activityTimestamp = Date.now();
    }, 1000);

    // Map<uWS.WebSocket, ClientConnection>
    this.connectionBySocket = new Map();

    // Map<uWS.WebSocket, Array.<Buffer>>
    this.backpressureBuffer = new Map();

    // Map<string, uWS.WebSocket>
    this.socketByConnectionId = new Map();
  }

  async init (entrypoint) {
    super.init(null, entrypoint);

    this.config = entrypoint.config.protocols;

    this.wsConfig = this.parseWebSocketOptions();
    this.httpConfig = this.parseHttpOptions();

    if (!this.wsConfig.enabled && !this.httpConfig.enabled) {
      return false;
    }

    // eslint-disable-next-line new-cap
    this.server = uWS.App();

    if (this.wsConfig.enabled) {
      this.initWebSocket();
    }

    if (this.httpConfig.enabled) {
      this.initHttp();
    }

    this.server.listen(entrypoint.config.port, socket => {
      if (!socket) {
        throw new Error(`[http/websocket] fatal: unable to listen to port ${entrypoint.config.port}`);
      }
    });

    return true;
  }

  initWebSocket () {
    /* eslint-disable sort-keys */
    this.server.ws('/*', {
      ...this.wsConfig.opts,
      maxBackPressure: WS_PER_SOCKET_BACKPRESSURE_BUFFER_SIZE,
      open: this.wsOnOpenHandler.bind(this),
      close: this.wsOnCloseHandler.bind(this),
      message: this.wsOnMessageHandler.bind(this),
      drain: this.wsOnDrainHandler.bind(this),
    });
    /* eslint-enable sort-keys */
  }

  initHttp () {
    this.server.any('/*', this.httpOnMessageHandler.bind(this));
  }

  broadcast (data) {
    const stringified = JSON.stringify(data.payload);
    const payloadByteSize = Buffer.from(stringified).byteLength;
    // 255 bytes should be enough to hold the following:
    //     ,"room":"<channel identifier>"
    // (with current channel encoding, this is less than 100 bytes)
    const payload = Buffer.allocUnsafe(payloadByteSize + 255);

    let offset = payloadByteSize - 1;

    payload.write(stringified, 0);
    payload.write(JSON_ROOM_PROPERTY, offset);

    offset += JSON_ROOM_PROPERTY.length;

    for (const channel of data.channels) {
      // Adds the room property to the message
      payload.write(channel, offset);
      payload.write(JSON_ENDER, offset + channel.length);

      // prevent buffer overwrites due to sending packets being an
      // async method (race condition)
      const payloadLength = offset + channel.length + JSON_ENDER.length;
      const payloadSafeCopy = Buffer.allocUnsafe(payloadLength);

      payload.copy(payloadSafeCopy, 0, 0, payloadLength);

      debugWS('Publishing to channel "realtime/%s": %s', channel, payloadSafeCopy);
      this.server.publish(`realtime/${channel}`, payloadSafeCopy, false);
    }
  }

  notify (data) {
    const socket = this.socketByConnectionId.get(data.connectionId);
    debugWS('notify: %a', data);

    if (!socket) {
      return;
    }

    const payload = data.payload;

    for (let i = 0; i < data.channels.length; i++) {
      payload.room = data.channels[i];
      this.wsSend(socket, Buffer.from(JSON.stringify(payload)));
    }
  }

  joinChannel (channel, connectionId) {
    const socket = this.socketByConnectionId.get(connectionId);

    if (!socket) {
      return;
    }

    debugWS('Subscribing connection ID "%s" to channel "realtime/%s"', connectionId, channel);
    socket.subscribe(`realtime/${channel}`);
  }

  leaveChannel (channel, connectionId) {
    const socket = this.socketByConnectionId.get(connectionId);

    if (!socket) {
      return;
    }

    debugWS('Removing connection ID "%s" from channel "realtime/%s"', connectionId, channel);

    socket.unsubscribe(`realtime/${channel}`);
  }

  disconnect (connectionId, message = null) {
    debugWS('[%s] forced disconnect', connectionId);

    const socket = this.socketByConnectionId.get(connectionId);

    if (!socket) {
      return;
    }

    socket.end(
      WS_FORCED_TERMINATION_CODE,
      message ? Buffer.from(message) : WS_GENERIC_CLOSE_MESSAGE);
  }

  wsOnOpenHandler (socket) {
    const ip = Buffer.from(socket.getRemoteAddressAsText()).toString();
    const connection = new ClientConnection(this.name, [ip]);

    this.entryPoint.newConnection(connection);
    this.connectionBySocket.set(socket, connection);
    this.socketByConnectionId.set(connection.id, socket);
    this.backpressureBuffer.set(socket, []);
  }

  wsOnCloseHandler (socket, code, message) {
    const connection = this.connectionBySocket.get(socket);

    if (!connection) {
      return;
    }

    if (debugWS.enabled) {
      debugWS(
        '[%s] received a `close` event (CODE: %d, REASON: %s)',
        connection.id,
        code,
        Buffer.from(message || '').toString());
    }
    this.entryPoint.removeConnection(connection.id);
    this.connectionBySocket.delete(socket);
    this.backpressureBuffer.delete(socket);
    this.socketByConnectionId.delete(connection.id);
  }

  wsOnMessageHandler (socket, data) {
    if (!data || data.byteLength === 0) {
      return;
    }

    const connection = this.connectionBySocket.get(socket);

    // enforce rate limits
    if (this.wsConfig.rateLimit > 0) {
      if (socket.last === this.now) {
        socket.count++;

        if (socket.count > this.wsConfig.rateLimit) {
          this.wsSendError(socket, connection, WS_RATE_LIMIT_EXCEEDED_ERROR);
          return;
        }
      }
      else {
        socket.last = this.now;
        socket.count = 1;
      }
    }

    let parsed;
    const message = Buffer.from(data).toString();

    debugWS('[%s] client message: %s', connection.id, message);

    try {
      parsed = JSON.parse(message);
    }
    catch (e) {
      /*
       we cannot add a "room" information since we need to extract
       a request ID from the incoming data, which is apparently
       not a valid JSON
       So... the error is forwarded to the client, hoping they know
       what to do with it.
       */
      this.wsSendError(
        socket,
        connection,
        kerrorWS.getFrom(e, 'unexpected_error', e.message));
      return;
    }

    if (parsed.p && parsed.p === 1 && Object.keys(parsed).length === 1) {
      debugWS('[%s] sending back a "pong" message', connection.id);
      this.wsSend(socket, WS_APP_PONG_RESPONSE);
      return;
    }

    let request;

    try {
      request = new Request(parsed, { connection });
    }
    catch (e) {
      this.wsSendError(socket, connection, e);
      return;
    }

    this.entryPoint.execute(request, result => {
      if (result.content) {
        if (typeof result.content === 'object') {
          result.content.room = result.requestId;
        }
      }
      else {
        result.content = '';
      }

      this.wsSend(socket, Buffer.from(JSON.stringify(result.content)));
    });
  }

  /**
   * Absorb as much of the backpressure buffer as possible
   * @param  {uWS.WebSocket} socket
   */
  wsOnDrainHandler (socket) {
    socket.cork(() => {
      const buffer = this.backpressureBuffer.get(socket);

      while (buffer.length > 0
        && socket.getBufferedAmount() < WS_PER_SOCKET_BACKPRESSURE_BUFFER_SIZE
      ) {
        const payload = buffer.shift();
        socket.send(payload);
      }
    });
  }

  /**
   * Forwards an error to a socket
   *
   * @param  {uWS.WebSocket} socket
   * @param  {ClientConnection} connection
   * @param  {Error} error
   */
  wsSendError (socket, connection, error) {
    const request = new Request({}, { connection, error });
    const sanitized = removeErrorStack(request.response.toJSON()).content;

    this.wsSend(socket, Buffer.from(JSON.stringify(sanitized)));
  }

  /**
   * Sends a message immediately, or queue it up for later if backpressure built
   * up
   *
   * @param  {uWS.WebSocket} socket
   * @param  {Buffer} payload
   */
  wsSend (socket, payload) {
    if (!this.connectionBySocket.has(socket)) {
      return;
    }

    if (socket.getBufferedAmount() < WS_PER_SOCKET_BACKPRESSURE_BUFFER_SIZE) {
      socket.cork(() => socket.send(payload));
    }
    else {
      const buffer = this.backpressureBuffer.get(socket);
      buffer.push(payload);

      // Client socket too slow: we need to close it
      if (buffer.length > WS_BACKPRESSURE_BUFFER_MAX_LENGTH) {
        socket.end(WS_FORCED_TERMINATION_CODE, WS_BACKPRESSURE_MESSAGE);
      }
    }
  }

  /**
   * @param  {uWS.HttpResponse} response
   * @param  {uWS.HttpRequest} request
   */
  httpOnMessageHandler (response, request) {
    const connection = new ClientConnection(
      'HTTP/1.1',
      getHttpIps(response, request),
      request.headers);
    const message = new HttpMessage(connection, request);

    debugHTTP('[%s] Received HTTP request: %a', connection.id, message);

    if (message.headers['content-length'] > this.maxRequestSize) {
      this.httpSendError(message, response, HTTP_REQUEST_TOO_LARGE_ERROR);
      return;
    }

    const contentType = message.headers['content-type'];

    if ( contentType
      && !HTTP_ALLOWED_CONTENT_TYPES.some(allowed => contentType.includes(allowed))
    ) {
      this.httpSendError(
        message,
        response,
        kerrorHTTP.get('unsupported_content', contentType));
      return;
    }

    const encoding = CHARSET_REGEX.exec(contentType);

    if (encoding !== null && encoding[1].toLowerCase() !== 'utf-8') {
      this.httpSendError(
        message,
        response,
        kerrorHTTP.get('unsupported_charset', encoding[1].toLowerCase()));
      return;
    }

    this.httpReadData(message, response, err => {
      if (err) {
        this.httpSendError(message, response, err);
        return;
      }

      this.httpProcessRequest(response, message);
    });
  }

  /**
   * Read an HTTP payload data
   *
   * @param  {HttpMessage} message
   * @param  {uWS.HttpResponse} response
   * @param  {Function} cb
   */
  httpReadData (message, response, cb) {
    let payload = null;
    response.aborted = false;

    response.onData((data, isLast) => {
      const chunk = Buffer.from(data);

      payload = payload
        ? Buffer.concat([payload, chunk])
        : Buffer.concat([chunk]);

      /*
       * The content-length header can be bypassed and
       * is not reliable enough. We have to enforce the HTTP
       * max size limit while reading chunks too
       */
      if (payload.byteLength > this.maxRequestSize) {
        cb(HTTP_REQUEST_TOO_LARGE_ERROR);
        return;
      }

      if (!isLast) {
        return;
      }

      if (payload.byteLength === 0) {
        cb();
        return;
      }

      this.httpUncompress(message, payload, (err, inflated) => {
        if (err) {
          cb(err);
          return;
        }

        this.httpParseContent(message, inflated, cb);
      });
    });

    // Beware: the "response" object might be invalidated at any point of time,
    // whenever the connection gets closed by the client for instance
    response.onAborted(() => {
      response.aborted = true;
    });
  }

  httpParseContent (message, content, cb) {
    const type = message.headers['content-type'] || '';

    if (type.includes('multipart/form-data')) {
      const parts = uWS.getParts(content, message.headers['content-type']);
      message.content = {};

      for (const part of parts) {
        if (part.data.byteLength > this.maxFormFileSize) {
          cb(HTTP_FILE_TOO_LARGE_ERROR);
        }

        if (part.filename) {
          message.content[part.name] = {
            encoding: part.type,
            file: Buffer.from(part.data).toString('base64'),
            filename: part.filename,
          };
        }
        else {
          message.content[part.name] = Buffer.from(part.data).toString();
        }
      }
    }
    else if (type.includes('application/x-www-form-urlencoded')) {
      message.content = querystring.parse(content.toString());
    }
    else {
      try {
        message.content = JSON.parse(content.toString());
      }
      catch (e) {
        cb(kerrorHTTP.get('body_parse_failed', content.toString().slice(0, 50)));
        return;
      }
    }

    cb();
  }

  httpProcessRequest (response, message) {
    debugHTTP('[%s] httpProcessRequest: %a', message.connection.id, message);

    if (response.aborted) {
      return;
    }

    this.entryPoint.newConnection(message.connection);

    global.kuzzle.router.http.route(message, request => {
      this.entryPoint.logAccess(request, message);
      this.entryPoint.removeConnection(message.connection.id);

      if (response.aborted) {
        return;
      }

      const data = this.httpRequestToResponse(request, message);

      this.httpCompress(message, data, result => {
        if (response.aborted) {
          return;
        }

        request.response.setHeader('Content-Encoding', result.encoding);
        request.response.setHeader('Content-Length', result.compressed.length);

        response.cork(() => {
          response.writeStatus(Buffer.from(request.response.status.toString()));

          for (const header of this.httpConfig.headers) {
            response.writeHeader(header[0], header[1]);
          }

          for (const [key, value] of Object.entries(request.response.headers)) {
            response.writeHeader(Buffer.from(key), Buffer.from(value.toString()));
          }

          const [ success ] = response.tryEnd(
            result.compressed,
            result.compressed.length);

          if (!success) {
            response.onWritable(offset => {
              const retryData = result.compressed.subarray(offset);
              const [ retrySuccess ] = response.tryEnd(
                retryData,
                retryData.length);

              return retrySuccess;
            });
          }
        });
      });
    });
  }

  /**
   * Forward an error response to the client
   *
   * @param {HttpMessage} message
   * @param {uWS.HttpResponse} response
   * @param {Error} error
   */
  httpSendError (message, response, error) {
    const kerr = error instanceof KuzzleError
      ? error
      : kerrorHTTP.getFrom(error, 'unexpected_error', error.message);

    const content = Buffer.from(JSON.stringify(removeErrorStack(kerr)));

    debugHTTP('[%s] httpSendError: %a', message.connection.id, kerr);

    this.entryPoint.logAccess(
      new Request(message, {
        connectionId: message.connection.id,
        error: kerr,
      }),
      message);
    this.entryPoint.removeConnection(message.connection.id);

    if (response.aborted) {
      return;
    }

    response.cork(() => {
      response.writeStatus(Buffer.from(kerr.status.toString()));

      for (const header of this.httpConfig.headers) {
        response.writeHeader(header[0], header[1]);
      }

      response.writeHeader(
        HTTP_HEADER_CONTENT_LENGTH,
        Buffer.from(content.length.toString()));

      response.end(content);
    });
  }

  /**
   * Convert a Kuzzle query result into an appropriate payload format
   * to send back to the client
   *
   * @param {Request} request
   * @param {HttpMessage} message
   * @returns {Buffer}
   */
  httpRequestToResponse(request, message) {
    let data = removeErrorStack(request.response.toJSON());

    if (message.requestId !== data.requestId) {
      data.requestId = message.requestId;

      if (!data.raw) {
        data.content.requestId = message.requestId;
      }
    }

    debugHTTP('HTTP request response: %a', data);

    if (data.raw) {
      if (data.content === null || data.content === undefined) {
        data = '';
      }
      else if (typeof data.content === 'object') {
        /*
         This object can be either a Buffer object, a stringified Buffer object,
         or anything else.
         In the former two cases, we create a new Buffer object, and in the
         latter, we stringify t he content.
         */
        if ( data.content instanceof Buffer
          || (data.content.type === 'Buffer' && Array.isArray(data.content.data))
        ) {
          data = data.content;
        }
        else {
          data = JSON.stringify(data.content);
        }
      }
      else {
        // scalars are sent as strings
        data = data.content.toString();
      }
    }
    else {
      let indent = 0;
      const parsedUrl = url.parse(message.url, true);

      if (parsedUrl.query && parsedUrl.query.pretty !== undefined) {
        indent = 2;
      }

      data = JSON.stringify(data.content, undefined, indent);
    }

    return Buffer.from(data);
  }

  /**
   * Compress an outgoing message according to the
   * specified accept-encoding HTTP header
   *
   * @param  {HttpMessage} message
   * @param  {Buffer} data
   * @param  {Function} callback
   */
  httpCompress(message, data, callback) {
    if (message.headers['accept-encoding']) {
      const encodings = message.headers['accept-encoding']
        .split(',')
        .map(e => e.trim().toLowerCase());

      let algorithm;
      let priority = -1;

      for (const encoding of encodings) {
        if (encoding.startsWith('gzip') || encoding.startsWith('deflate')) {
          let [ _algorithm, _priority = 'q=0' ] = encoding.split(';');
          _priority = Number.parseFloat(_priority.split('=')[1] || 0);

          if (_priority > priority) {
            algorithm = _algorithm;
            priority = _priority;
          }
          // gzip should be the preferred algorithm in case of a tie
          else if (Math.abs(priority - _priority) < 10e-3
            && _algorithm === 'gzip'
          ) {
            algorithm = 'gzip';
          }
        }
      }

      if (algorithm === 'gzip') {
        zlib.gzip(data, (err, compressed) => callback({
          compressed: !err ? compressed : data,
          encoding: !err ? 'gzip' : 'identity',
        }));
        return;
      }
      else if (algorithm === 'deflate') {
        zlib.deflate(data, (err, compressed) => callback({
          compressed: !err ? compressed : data,
          encoding: !err ? 'deflate' : 'identity',
        }));
        return;
      }
    }

    callback({
      compressed: data,
      encoding: 'identity',
    });
  }

  httpUncompress (message, payload, cb) {
    let encodings = message.headers['content-encoding'];
    if (!encodings) {
      cb(null, payload);
      return;
    }

    encodings = encodings.split(',').map(e => e.trim().toLowerCase());

    if (encodings.length > this.httpConfig.opts.maxEncodingLayers) {
      cb(kerrorHTTP.get('too_many_encodings'));
      return;
    }

    // encodings are listed in the same order they have been applied
    // this means that we need to invert the list to correctly
    // decode the message
    encodings.reverse();

    this.httpUncompressStep(encodings, payload, cb, 0);
  }

  httpUncompressStep (encodings, payload, cb, index) {
    if (index === encodings.length) {
      cb(null, payload);
      return;
    }

    const encoding = encodings[index];

    if (encoding === 'identity') {
      this.httpUncompressStep(encodings, payload, cb, index + 1);
    }
    else if (encoding === 'gzip' || encoding === 'deflate') {
      const fn = encoding === 'gzip' ? zlib.gunzip : zlib.inflate;

      fn(payload, (err, inflated) => {
        if (err) {
          cb(err);
          return;
        }

        this.httpUncompressStep(encodings, inflated, cb, index + 1);
      });
    }
    else {
      cb(kerrorHTTP.get('unsupported_compression', encoding));
    }
  }

  parseWebSocketOptions () {
    const cfg = this.config.websocket;

    if (cfg === undefined) {
      global.kuzzle.log.warn('[websocket] no configuration found for websocket: disabling it');
      return { enabled: false };
    }

    let idleTimeout = cfg.idleTimeout;
    const compression = cfg.compression ? uWS.SHARED_COMPRESSOR : uWS.DISABLED;

    if (idleTimeout === 0 || idleTimeout < 1000) {
      idleTimeout = DEFAULT_IDLE_TIMEOUT;
      global.kuzzle.log.warn(`[websocket] The "idleTimeout" parameter can neither be deactivated or be set with a value lower than 1000. Defaulted to ${DEFAULT_IDLE_TIMEOUT}.`);
    }

    /**
     * @deprecated -- to be removed in the next major version
     */
    if (cfg.heartbeat) {
      global.kuzzle.log.warn('[websocket] The "heartbeat" parameter has been deprecated and is now ignored. The "idleTimeout" parameter should now be configured instead.');
    }

    return {
      enabled: cfg.enabled,
      opts: {
        compression,
        idleTimeout,
        maxPayloadLength: this.maxRequestSize,
      },
      rateLimit: cfg.rateLimit,
    };
  }

  parseHttpOptions () {
    const cfg = this.config.http;

    if (cfg === undefined) {
      global.kuzzle.log.warn('[http] no configuration found for http: disabling it');
      return { enabled: false };
    }

    // precomputes default headers
    const httpCfg = global.kuzzle.config.http;
    const headers = [
      [ 'Access-Control-Allow-Headers', httpCfg.accessControlAllowHeaders ],
      [ 'Access-Control-Allow-Methods', httpCfg.accessControlAllowMethods ],
      [ 'Access-Control-Allow-Origin', httpCfg.accessControlAllowOrigin ],
      [ 'Content-Type', 'application/json' ],
    ];

    for (const header of headers) {
      header[0] = Buffer.from(header[0]);
      header[1] = Buffer.from(header[1]);
    }

    return {
      enabled: cfg.enabled,
      headers,
      opts: {
        allowCompression: cfg.allowCompression,
        maxEncodingLayers: cfg.maxEncodingLayers,
        maxFormFileSize: cfg.maxFormFileSize,
      },
    };
  }
}

/**
 * Returns the list of IP addresses
 *
 * @param {uWS.HttpResponse} response
 * @param {uWS.HttpRequest} request
 * @return {Array.<string>}
 */
function getHttpIps (response, request) {
  const ips = [Buffer.from(response.getRemoteAddressAsText()).toString()];

  const forwardHeader = request.getHeader('x-forwarded-for');

  if (forwardHeader && forwardHeader.length > 0) {
    for (const header of forwardHeader.split(',')) {
      const trimmed = header.trim();

      if (trimmed.length > 0) {
        ips.push(trimmed);
      }
    }
  }

  return ips;
}

module.exports = HttpWsProtocol;