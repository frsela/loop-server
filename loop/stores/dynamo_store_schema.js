/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

module.exports = {
  urlsSchema: {
    AttributeDefinitions: [
      {
        AttributeName: "user",
        AttributeType: "S"
      },
      {
        AttributeName: "simplepushURL",
        AttributeType: "S"
      }
    ],
    KeySchema: [
      {
        AttributeName: "user",
        KeyType: "HASH"
      },
      {
        AttributeName: "simplepushURL",
        KeyType: "RANGE"
      }
    ],
    ProvisionedThroughput: {
      ReadCapacityUnits: 10, // Need to be configured for production
      WriteCapacityUnits: 10 // Need to be configured for production
    },
    TableName: "urlsStore"
  },

  callsSchema: {
    AttributeDefinitions: [
      {
        AttributeName: "sessionId",
        AttributeType: "N"
      }
    ],
    KeySchema: [
      {
        AttributeName: "sessionId",
        KeyType: "HASH"
      }
    ],
    ProvisionedThroughput: {
      ReadCapacityUnits: 10, // Need to be configured for production
      WriteCapacityUnits: 10 // Need to be configured for production
    },
    TableName: "callsStore"
  },

  testColl: {
    AttributeDefinitions: [
      {
        AttributeName: "a",
        AttributeType: "N"
      }
    ],
    KeySchema: [
      {
        AttributeName: "a",
        KeyType: "HASH"
      }
    ],
    ProvisionedThroughput: {
      ReadCapacityUnits: 10, // Need to be configured for production
      WriteCapacityUnits: 10 // Need to be configured for production
    },
    TableName: "testColl"
  },

  testColl2: {
    AttributeDefinitions: [
      {
        AttributeName: "a",
        AttributeType: "N"
      },
      {
        AttributeName: "b",
        AttributeType: "N"
      }
    ],
    KeySchema: [
      {
        AttributeName: "a",
        KeyType: "HASH"
      },
      {
        AttributeName: "b",
        KeyType: "RANGE"
      }
    ],
    ProvisionedThroughput: {
      ReadCapacityUnits: 10, // Need to be configured for production
      WriteCapacityUnits: 10 // Need to be configured for production
    },
    TableName: "testColl2"
  }
};
