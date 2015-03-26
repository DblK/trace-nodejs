var http = require('http');

var uuid = require('node-uuid');
var microtime = require('microtime');

var createNamespace = require('continuation-local-storage').createNamespace;
var session = createNamespace('seetru');

var HEADER_NAME = 'x-request-id';

var IncomingMessageCollector = require('./IncomingMessageCollector');
var ClientRequestCollector = require('./ClientRequestCollector');
var Shimmer = require('./Shimmer');

var whiteListHosts = ['localhost:8000'];

/*
 * @method wrapListener
 * @param {Function} listener
 * @returns {Function} listener
 */
function wrapListener(listener, incomingCollector) {
  return function (request, response) {
    var headers = request.headers;
    var requestId = headers[HEADER_NAME] || uuid.v1();
    var collectorDataBag = {
      id: requestId,
      host: headers.host,
      url: request.originalUrl || request.url,
      time: microtime.now(),
      headers: request.headers
    };

    // Set tracking header
    session.set(HEADER_NAME, requestId);

    // Collect request start
    var time = process.hrtime();
    process.nextTick(function () {
      incomingCollector.emit(IncomingMessageCollector.STARTED, collectorDataBag);
    });

    /*
     * @method instrumentedFinish
     */
    function instrumentedFinish() {
      var requestId = session.get(HEADER_NAME);
      var collectorDataBag = {
        id: requestId,
        host: headers.host,
        url: request.originalUrl || request.url,
        time: microtime.now()
      };

      // Collect request ended
      process.nextTick(function () {
        incomingCollector.emit(IncomingMessageCollector.FINISHED, collectorDataBag);
      });
    }

    response.once('finish', instrumentedFinish);

    return listener.apply(this, arguments);
  };
}

/*
 * @method seetru
 */
function seetru (options) {

  var incomingCollector = new IncomingMessageCollector(options);
  var outgoingCollector = new ClientRequestCollector(options);

  Shimmer.wrap(http.Server.prototype, 'http.Server.prototype', ['on', 'addListener'], function (addListener) {
    return function (type, listener) {
      if (type === 'request' && typeof listener === 'function') {
        return addListener.call(this, type, session.bind(wrapListener(listener, incomingCollector)));
      } else {
        return addListener.apply(this, arguments);
      }
    };
  });

  Shimmer.wrap(http, 'http', 'request', function (original) {
    return function (requestParams) {
      
      if (whiteListHosts.indexOf(requestParams.host + ':' +requestParams.port) > -1) {
        return original.apply(this, arguments);
      }

      var requestId = session.get(HEADER_NAME);
      var collectorDataBag = {
        id: requestId,
        host: requestParams.host + ':' + requestParams.port,
        url: requestParams.path,
        time: microtime.now(),
        headers: requestParams.headers
      };

      var returned;

      // Collect request start
      process.nextTick(function () {
        outgoingCollector.emit(ClientRequestCollector.STARTED, collectorDataBag);
      });

      requestParams.headers = requestParams.headers || {};
      requestParams.headers[HEADER_NAME] = requestId;
      returned = original.apply(this, arguments);

      returned.on('response', function (incomingMessage) {
        var collectorDataBag = {
          id: requestId,
          host: requestParams.host + ':' + requestParams.port,
          url: requestParams.path,
          time: microtime.now(),
          headers: incomingMessage.headers
        };
        outgoingCollector.emit(ClientRequestCollector.FINISHED, collectorDataBag);
      });

      return returned;
    };
  });
}

module.exports = seetru;