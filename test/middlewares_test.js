/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var addHawk = require("superagent-hawk");
var supertest = addHawk(require("supertest"));
var sinon = require("sinon");
var loop = require("../loop");
var app = loop.app;
var apiRouter = loop.apiRouter;
var apiPrefix = loop.apiPrefix;
var logMetrics = require("../loop/middlewares").logMetrics;
var hekaLogger = require("../loop/middlewares").hekaLogger;
var expect = require("chai").expect;
var conf = loop.conf;
var pjson = require('../package.json');
var os = require("os");

var fakeNow = 1393595554796;


describe("metrics middleware", function() {
  var sandbox;
  var logs = [];
  var old_metrics;
  var clock;

  apiRouter.get("/with-metrics-middleware", logMetrics, function(req, res) {
    req.user = 'uuid';
    req.callId = '1234';
    req.callUrlData = 'data';
    res.status(200).json();
  });

  beforeEach(function() {
    sandbox = sinon.sandbox.create();
    clock = sinon.useFakeTimers(fakeNow);
    old_metrics = conf.get('metrics');
    conf.set('metrics', true);
    sandbox.stub(hekaLogger, "log", function(info, log) {
      logs.push(log);
    });
  });

  afterEach(function() {
    sandbox.restore();
    conf.set('metrics', old_metrics);
    clock.restore();
  });


  it("should write logs to stdout", function(done) {
    supertest(app)
      .get(apiPrefix + '/with-metrics-middleware')
      .set('user-agent', 'Mouzilla')
      .set('accept-language', 'Breton du sud')
      .set('x-forwarded-for', 'ip1, ip2, ip3')
      .expect(200)
      .end(function(err) {
        if (err) {
          throw err;
        }
        var logged = logs[0];

        expect(logged.op).to.eql('request.summary');
        expect(logged.code).to.eql(200);
        expect(logged.path).to.eql('/with-metrics-middleware');
        expect(logged.uid).to.eql('uuid');
        expect(logged.callId).to.eql('1234');
        expect(logged.agent).to.eql('Mouzilla');
        expect(logged.v).to.eql(pjson.version);
        expect(logged.name).to.eql(pjson.name);
        expect(logged.hostname).to.eql(os.hostname());
        expect(logged.lang).to.eql('Breton du sud');
        expect(logged.ip).to.eql('ip1, ip2, ip3');
        expect(logged.errno).to.eql(0);
        expect(logged.time).to.eql('2014-02-28T13:52:34Z');
        expect(logged.method).to.eql('get');

        done();
      });
  });
});
