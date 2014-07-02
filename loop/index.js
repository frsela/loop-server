/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var conf = require('./config').conf;

// Configure http agents to use more than the default number of sockets.
var http = require('http');
var https = require('https');
https.globalAgent.maxSockets = conf.get('maxHTTPSockets');
http.globalAgent.maxSockets = conf.get('maxHTTPSockets');

var express = require('express');
var tokenlib = require('./tokenlib');
var crypto = require('crypto');
var pjson = require('../package.json');
var request = require('request');
var raven = require('raven');
var cors = require('cors');
var errors = require('connect-validation');
var StatsdClient = require('statsd-node').client;
var addHeaders = require('./middlewares').addHeaders;
var handle503 = require("./middlewares").handle503;
var logRequests = require('./middlewares').logRequests;
var async = require('async');
var websockets = require('./websockets');
var encrypt = require("./encrypt").encrypt;
var decrypt = require("./encrypt").decrypt;
var getProgressURL = require('./utils').getProgressURL;

var hawk = require('./hawk');
var hmac = require('./hmac');
var fxa = require('./fxa');

if (conf.get("fakeTokBox") === true) {
  console.log("Calls to TokBox are now mocked.");
  var TokBox = require('./tokbox').FakeTokBox;
} else {
  var TokBox = require('./tokbox').TokBox;
}

var getStorage = require('./storage');
var storage = getStorage(conf.get("storage"), {
  'tokenDuration': conf.get('tokBox').tokenDuration,
  'hawkSessionDuration': conf.get('hawkSessionDuration'),
  'callDuration': conf.get('callDuration'),
  'maxSimplePushUrls': conf.get('maxSimplePushUrls')
});

var tokBox = new TokBox(conf.get('tokBox'));

var ravenClient = new raven.Client(conf.get('sentryDSN'));
var statsdClient;
if (conf.get('statsdEnabled') === true) {
  statsdClient = new StatsdClient(conf.get('statsd'));
}
var hawkOptions = {
  port: conf.get("protocol") === "https" ? 443 : undefined
};

function logError(err) {
  console.log(err);
  ravenClient.captureError(err);
}

/**
 * Attach the identity of the user to the request if she is registered in the
 * database.
 **/
function setUser(req, res, tokenId, done) {
  req.hawkIdHmac = hmac(tokenId, conf.get("hawkIdSecret"));
  storage.getHawkUser(req.hawkIdHmac, function(err, user) {
    if (res.serverError(err)) return;

    storage.touchHawkSession(req.hawkIdHmac);
    // If an identity is defined for this hawk session, use it.
    if (user !== null) {
      req.user = user;
      done();
      return;
    }
    req.user = req.hawkIdHmac;
    done();
  });
}

function getHawkSession(tokenId, callback) {
  storage.getHawkSession(hmac(tokenId, conf.get("hawkIdSecret")), callback);
}

function createHawkSession(tokenId, authKey, callback) {
  var hawkIdHmac = hmac(tokenId, conf.get("hawkIdSecret"));
  storage.setHawkSession(hawkIdHmac, authKey, function(err, data) {
    if(statsdClient && err === null) {
      statsdClient.count('loop-activated-users', 1);
    }
    callback(err, data);
  });
}

/**
 * Middleware that requires a valid hawk session.
 **/
var requireHawkSession = hawk.getMiddleware(
  hawkOptions, getHawkSession, setUser
);

/**
 * Middleware that uses a valid hawk session or create one if none already
 * exist.
 **/
var attachOrCreateHawkSession = hawk.getMiddleware(
  hawkOptions, getHawkSession, createHawkSession, setUser
);

/**
 * Middleware that requires a valid FxA assertion.
 *
 * In case of success, return an hawk session token in the headers.
 **/
var requireFxA = fxa.getMiddleware({
    audiences: conf.get('fxaAudiences'),
    trustedIssuers: conf.get('fxaTrustedIssuers')
  },
  function(req, res, assertion, next) {
    var idpClaims = assertion.idpClaims;

    var identifier = idpClaims['fxa-verifiedEmail'] ||
                     idpClaims.verifiedMSISDN;

    if (identifier === undefined) {
      logError(new Error("Assertion is invalid: " + assertion));
      res.sendError("header", "Authorization",
        "BrowserID assertion is invalid");
      return;
    }

    var userHmac = hmac(identifier, conf.get('hawkIdSecret'));

    // generate the hawk session.
    hawk.generateHawkSession(createHawkSession,
      function(err, tokenId, authKey, sessionToken) {
        var hawkIdHmac = hmac(tokenId, conf.get("hawkIdSecret"));
        var encryptedIdentifier = encrypt(tokenId, identifier);
        storage.setHawkUser(userHmac, hawkIdHmac, function(err) {
          if (res.serverError(err)) return;
          storage.setHawkUserId(hawkIdHmac, encryptedIdentifier, function(err) {
            if (res.serverError(err)) return;

            // return hawk credentials.
            hawk.setHawkHeaders(res, sessionToken);
            req.user = userHmac;
            next();
          });
        });
      }
    );
  }
);

/**
 * Middleware that requires either BrowserID, Hawk, or nothing.
 *
 * In case no authenticate scheme is provided, creates and return a new hawk
 * session.
 **/
function authenticate(req, res, next) {
  var supported = ["BrowserID", "Hawk"];

  // First thing: check that the headers are valid. Otherwise 401.
  var authorization = req.headers.authorization;

  function _unauthorized(message, supported){
    res.set('WWW-Authenticate', supported.join());
    res.json(401, message || "Unauthorized");
  }

  if (authorization !== undefined) {
    var splitted = authorization.split(" ");
    var policy = splitted[0];

    // Next, let's check which one the user wants to use.
    if (supported.map(function(s) { return s.toLowerCase(); })
        .indexOf(policy.toLowerCase()) === -1) {
      _unauthorized("Unsupported", supported);
      return;
    }

    if (policy.toLowerCase() === "browserid") {
      // If that's BrowserID, then check and create hawk credentials, plus
      // return them.
      requireFxA(req, res, next);
    } else if (policy.toLowerCase() === "hawk") {
      // If that's Hawk, let's check they're valid.
      requireHawkSession(req, res, next);
    }
  } else {
    // unauthenticated.
    attachOrCreateHawkSession(req, res, next);
  }
}

/**
 * Helper to store and trigger an user initiated call.
 *
 * options is a javascript object which can have the following keys:
 * - user: the identifier of the connected user;
 * - callerId: the identifier for the caller;
 * - urls: the list of simple push urls to notify of the new call;
 * - calleeFriendlyName: the friendly name of the person called;
 * - callToken: the call token that was used to initiate the call (if any;
 * - progressURL: the progress URL that will be used by the web sockets.
 */
function returnUserCallTokens(options, res) {
  tokBox.getSessionTokens(function(err, tokboxInfo) {
    if (res.serverError(err)) return;

    var urls = options.urls;
    var currentTimestamp = Date.now();
    var callId = crypto.randomBytes(16).toString('hex');

    var wsCalleeToken = crypto.randomBytes(16).toString('hex');
    var wsCallerToken = crypto.randomBytes(16).toString('hex');

    storage.addUserCall(options.user, {
      'callId': callId,
      'callType': options.callType,
      'callState': "init",
      'timestamp': currentTimestamp,

      'userMac': options.user,
      'callerId': options.callerId,
      'calleeFriendlyName': options.calleeFriendlyName,

      'sessionId': tokboxInfo.sessionId,
      'calleeToken': tokboxInfo.calleeToken,

      'wsCallerToken': wsCallerToken,
      'wsCalleeToken': wsCalleeToken,

      'callToken': options.callToken,
      'urlCreationDate': options.urlCreationDate
    }, function(err) {
      if (res.serverError(err)) return;

      storage.setCallState(callId, "init",
        conf.get("timers").supervisoryDuration, function() {
          if (res.serverError(err)) return;

          // Call SimplePush urls.
          if (!Array.isArray(urls)) {
            urls = [urls];
          }

          urls.forEach(function(simplePushUrl) {
            request.put({
              url: simplePushUrl,
              form: { version: currentTimestamp }
            });
          });

          res.json(200, {
            callId: callId,
            websocketToken: wsCallerToken,
            sessionId: tokboxInfo.sessionId,
            sessionToken: tokboxInfo.callerToken,
            apiKey: tokBox.apiKey,
            progressURL: options.progressURL
          });
        });
    });
  });
}

var app = express();

if (conf.get("env") === "dev") {
  app.use(logRequests);
}
app.use(addHeaders);
app.disable('x-powered-by');
app.use(express.json());
app.use(express.urlencoded());
app.use(handle503(logError));
app.use(errors);
app.use(app.router);
// Exception logging should come at the end of the list of middlewares.
app.use(raven.middleware.express(conf.get('sentryDSN')));

var corsEnabled = cors({
  origin: function(origin, callback) {
    var allowedOrigins = conf.get('allowedOrigins');
    var acceptedOrigin = allowedOrigins.indexOf('*') !== -1 ||
                         allowedOrigins.indexOf(origin) !== -1;
    callback(null, acceptedOrigin);
  }
});

/**
 * Middleware that validates the given token is valid (should be included into
 * the "token" parameter.
 **/
function validateToken(req, res, next) {
  req.token = req.param('token');
  storage.getCallUrlData(req.token, function(err, urlData) {
    if (res.serverError(err)) return;
    if (urlData === null) {
      res.send(404, "Not found");
      return;
    }
    req.callUrlData = urlData;
    next();
  });
}

/**
 * Middleware that requires the given parameters to be set.
 **/
function requireParams() {
  var params = Array.prototype.slice.call(arguments);
  return function(req, res, next) {
    var missingParams;

    if (!req.accepts("json")) {
      res.json(406, ['application/json']);
      return;
    }

    missingParams = params.filter(function(param) {
      return req.body[param] === undefined;
    });

    if (missingParams.length > 0) {
      missingParams.forEach(function(item) {
        res.addError("body", item, "missing: " + item);
      });
      res.sendError();
      return;
    }
    next();
  };
}

/**
 * Middleware that ensures a valid simple push url is present in the request.
 **/
function validateSimplePushURL(req, res, next) {
  requireParams("simple_push_url")(req, res, function() {
    req.simplePushURL = req.body.simple_push_url;
    if (req.simplePushURL.indexOf('http') !== 0) {
      res.sendError("body", "simple_push_url",
                    "simple_push_url should be a valid url");
      return;
    }
    next();
  });
}

/**
 * Middleware that ensures a valid callType is present in the request.
 **/
function validateCallType(req, res, next) {
  requireParams("callType")(req, res, function() {
    if (req.body.callType !== "audio" && req.body.callType !== "audio-video") {
      res.sendError("body", "callType", "Should be 'audio' or 'audio-video'");
      return;
    }
    next();
  });
}

/**
 * Validates the call url params are valid.
 *
 * In case they aren't, error out with an HTTP 400.
 * If they are valid, store them in the urlData parameter of the request.
 **/
function validateCallUrlParams(req, res, next) {
  var expiresIn = conf.get('callUrlTimeout'),
      maxTimeout = conf.get('callUrlMaxTimeout');

  if (req.body.hasOwnProperty("expiresIn")) {
    expiresIn = parseInt(req.body.expiresIn, 10);

    if (isNaN(expiresIn)) {
      res.sendError("body", "expiresIn", "should be a valid number");
      return;
    } else if (expiresIn > maxTimeout) {
      res.sendError("body", "expiresIn", "should be less than " + maxTimeout);
      return;
    }
  }
  if (req.token === undefined) {
    req.token = tokenlib.generateToken(conf.get("callUrlTokenSize"));
  }

  req.urlData = {
    userMac: req.user,
    callerId: req.body.callerId,
    timestamp: parseInt(Date.now() / 1000),
    issuer: req.body.issuer || ''
  };

  if (expiresIn !== undefined) {
    req.urlData.expires = req.urlData.timestamp +
                          expiresIn * tokenlib.ONE_HOUR;
  }
  next();
}

/**
 * Enable CORS for all requests.
 **/
app.all('*', corsEnabled);

/**
 * Checks that the service and its dependencies are healthy.
 **/
app.get("/__heartbeat__", function(req, res) {
  storage.ping(function(storageStatus) {
    request.get(tokBox.serverURL, {timeout: conf.get('heartbeatTimeout')},
      function(requestError) {
        var status;
        if (storageStatus === true && requestError === null) {
          status = 200;
        } else {
          status = 503;
        }

        res.json(status, {
          storage: storageStatus,
          provider: (requestError === null) ? true : false
        });
      });
  });
});

/**
 * Displays some version information at the root of the service.
 **/
app.get("/", function(req, res) {
  var credentials = {
    name: pjson.name,
    description: pjson.description,
    version: pjson.version,
    homepage: pjson.homepage,
    endpoint: conf.get("protocol") + "://" + req.get('host'),
    fakeTokBox: conf.get('fakeTokBox')
  };

  if (!conf.get("displayVersion")) {
    delete credentials.version;
  }
  res.json(200, credentials);
});

/**
 * Registers the given user with the given simple push url.
 **/
app.post('/registration', authenticate, validateSimplePushURL,
    function(req, res) {
    storage.addUserSimplePushURL(req.user, req.simplePushURL,
      function(err) {
        if (res.serverError(err)) return;
        res.json(200, "ok");
      });
  });

/**
 * Deletes the given simple push URL (you need to have registered it to be able
 * to unregister).
 **/
app.delete('/registration', requireHawkSession, validateSimplePushURL,
  function(req, res) {
  storage.removeSimplePushURL(req.user, req.simplePushUrl, function(err) {
    if (res.serverError(err)) return;

    res.json(204, "");
  });
});


/**
 * Generates and return a call-url for the given callerId.
 **/
app.post('/call-url', requireHawkSession, requireParams('callerId'),
  validateCallUrlParams, function(req, res) {
    if (statsdClient !== undefined) {
      statsdClient.count('loop-call-urls', 1);
      statsdClient.count('loop-call-urls-' + req.user, 1);
    }

    storage.addUserCallUrlData(req.user, req.token, req.urlData,
      function(err) {
        if (res.serverError(err)) return;
        res.json(200, {
          callUrl: conf.get("webAppUrl").replace("{token}", req.token),
          expiresAt: req.urlData.expires
        });
      });
  });

/**
 * Return the callee friendly name for the given token.
 **/
app.get('/calls/:token', validateToken, function(req, res) {
  res.json(200, {
    calleeFriendlyName: req.callUrlData.issuer
  });
});

app.put('/call-url/:token', requireHawkSession, validateToken,
  validateCallUrlParams, function(req, res) {
    storage.updateUserCallUrlData(req.user, req.token, req.urlData,
      function(err) {
        if (err && err.notFound === true) {
          res.json(404, "Not Found");
          return;
        }
        else if (res.serverError(err)) return;

        res.json(200, {
          expiresAt: req.urlData.expires
        });
      });
  });

/**
 * List all the pending calls for the authenticated user.
 **/
app.get('/calls', requireHawkSession, function(req, res) {
    if (!req.query.hasOwnProperty('version')) {
      res.sendError("querystring", "version", "missing: version");
      return;
    }

    var version = req.query.version;

    storage.getUserCalls(req.user, function(err, records) {
      if (res.serverError(err)) return;

      var calls = records.filter(function(record) {
        return record.timestamp >= version;
      }).map(function(record) {
        return {
          callId: record.callId,
          callType: record.callType,
          callerId: record.callerId,
          websocketToken: record.wsCalleeToken,
          apiKey: tokBox.apiKey,
          sessionId: record.sessionId,
          sessionToken: record.calleeToken,
          callUrl: conf.get("webAppUrl").replace("{token}", record.callToken),
          urlCreationDate: record.urlCreationDate,
          progressURL: getProgressURL(req.get("host"))
        };
      });

      res.json(200, {calls: calls});
    });
  });

/**
 * Add a call from a registered user to another registered user.
 **/
app.post('/calls', requireHawkSession, requireParams('calleeId'),
  validateCallType, function(req, res) {

    storage.getHawkUserId(req.hawkIdHmac, function(err, encryptedUserId) {
      if (res.serverError(err)) return;

      var userId;
      if (encryptedUserId !== null) {
        userId = decrypt(req.hawk.id, encryptedUserId);
      }

      function callUser(calleeMac) {
        return function() {
          returnUserCallTokens({
            callType: req.body.callType,
            callerId: userId,
            user: calleeMac,
            progressURL: getProgressURL(req.get("host")),
            urls: callees[calleeMac]
          }, res);
        }();
      }

      var calleeId = req.body.calleeId;
      if (!Array.isArray(calleeId)) {
        calleeId = [calleeId];
      }

      // We get all the Loop users that match any of the ids provided by the
      // client. We may have none, one or multiple matches. If no match is found
      // we throw an error, otherwise we will follow the call process, storing
      // the call information and notifying to the correspoding matched users.
      var callees;
      async.each(calleeId, function(identity, callback) {
        var calleeMac = hmac(identity, conf.get('userMacSecret'));
        storage.getUserSimplePushURLs(calleeMac, function(err, urls) {
          if (err) {
            callback(err);
            return;
          }

          if (!callees) {
            callees = {};
          }
          callees[calleeMac] = urls;

          callback();
        });
      }, function(err) {
        if (res.serverError(err)) return;

        if (!callees) {
          res.json(400, 'No user to call found');
          return;
        }

        Object.keys(callees).forEach(callUser.bind(callees));
      });
    });
  });

/**
 * Revoke a given call url.
 **/
app.delete('/call-url/:token', requireHawkSession, validateToken,
  function(req, res) {
    if (req.callUrlData.userMac !== req.user) {
      res.json(403, "Forbidden");
      return;
    }
    storage.revokeURLToken(req.token, function(err, record) {
      if (res.serverError(err)) return;

      res.json(204, "");
    });
  });

/**
 * Initiate a call with the user identified by the given token.
 **/
app.post('/calls/:token', validateToken, validateCallType, function(req, res) {
  storage.getUserSimplePushURLs(req.callUrlData.userMac, function(err, urls) {
    if (res.serverError(err)) return;

    if (!urls) {
      res.json(410, 'Gone');
      return;
    }

    storage.getHawkUserId(req.hawkIdHmac, function(err, encryptedUserId) {
      if (res.serverError(err)) return;

      var userId;
      if (encryptedUserId !== null) {
        userId = decrypt(req.hawkIdHmac, encryptedUserId);
      }

      returnUserCallTokens({
        callType: req.callUrlData.callType,
        user: req.callUrlData.userMac,
        callerId: userId || req.callUrlData.callerId,
        calleeFriendlyName: req.callUrlData.issuer,
        callToken: req.token,
        urlCreationDate: req.callUrlData.timestamp,
        progressURL: getProgressURL(req.get("host")),
        urls: urls
      }, res);
    });
  });
});

/**
 * Returns the state of a given call.
 **/
app.get('/calls/id/:callId', function(req, res) {
  var callId = req.param('callId');
  storage.getCall(callId, function(err, result) {
    if (res.serverError(err)) return;

    if (result === null) {
      res.json(404, {error: "Call " + callId + " not found."});
      return;
    }
    res.json(200, "ok");
  });
});

/**
 * Rejects or cancel a given call.
 **/
app.delete('/calls/id/:callId', function(req, res) {
  var callId = req.param('callId');
  storage.deleteCall(callId, function(err, result) {
    if (res.serverError(err)) return;

    if (result === false) {
      res.json(404, {error: "Call " + callId + " not found."});
      return;
    }
    res.json(204, "");
  });
});


// Starts HTTP server.
var server = http.createServer(app);
server.listen(conf.get('port'), conf.get('host'), function(){
  console.log('Server listening on http://' +
              conf.get('host') + ':' + conf.get('port'));
});


// Handle websockets.
var ws = websockets(storage, logError, conf);
try {
  ws.register(server);
} catch (e) {
  logError(e);
}

// Handle SIGTERM signal.
function shutdown(cb) {
  server.close(function() {
    process.exit(0);
    if (cb !== undefined) {
      cb();
    }
  });
}

process.on('SIGTERM', shutdown);

module.exports = {
  app: app,
  server: server,
  conf: conf,
  storage: storage,
  validateToken: validateToken,
  requireParams: requireParams,
  request: request,
  tokBox: tokBox,
  statsdClient: statsdClient,
  authenticate: authenticate,
  requireHawkSession: requireHawkSession,
  validateSimplePushURL: validateSimplePushURL,
  validateCallType: validateCallType,
  returnUserCallTokens: returnUserCallTokens,
  shutdown: shutdown
};
