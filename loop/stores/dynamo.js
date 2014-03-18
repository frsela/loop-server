/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var dynamo = require('dynamo-client');
var schemas = require('./dynamo_store_schema');

/**
 * Simple DynamoDB key/value store. Handles a single collection to store data.
 *
 * Available options:
 *
 * - {Array} unique: list of fields which compound value should be unique.
 *
 * @param  {Object} settings    Settings object
 * @param  {Object} options     Options object
 * @return {DynamoStore}
 */
module.exports = function DynamoStore(settings, options) {
  "use strict";

  var _db,
      _setup,
      _tableSchema,
      _options = options || {},
      _settings = settings || {},
      _tableName = _options.tableName || _settings.tableName,
      _maxCount = _settings.maxCount || 5;

  if (!_options.hasOwnProperty('unique')) {
    _options.unique = [];
  }

  if (_tableName === undefined) {
    throw new Error("The tableName setting is required.");
  }
  _tableSchema = schemas[_tableName];

  if (!_settings.hasOwnProperty('region')) {
    if (!(_settings.hasOwnProperty('host') &&
          _settings.hasOwnProperty('port'))) {
      throw new Error("Either a region or a host, port settings are required.");
    } else {
      var credentials = {
        secretAccessKey: _settings.secretAccessKey || "fakeSecretAccessKey",
        accessKeyId: _settings.accessKeyId || "fakeAccessKeyID"
      };

      _db = dynamo.createClient({
        host: _settings.host,
        port: _settings.port,
        version: "20120810"
      }, credentials);
    }
  } else {
    var region = _settings.region;

    // In that case _settings either contain secretAccessKey and accessKeyId
    // Or they have been defined as environment variables
    //   - AWS_SECRET_ACCESS_KEY
    //   - AWS_ACCESS_KEY_ID
    var kwargs = {};

    if (_settings.hasOwnProperty('secretAccessKey') &&
        _settings.hasOwnProperty('accessKeyId')) {
      kwargs = {
        secretAccessKey: _settings.secretAccessKey,
        accessKeyId: _settings.accessKeyId
      };
    }

    _db = dynamo.createClient(region,  kwargs);
  }

  /**
   * Ensures the database is connected and the Table created and ACTIVE.
   *
   * @private
   * @param  {Function} cb Callback(err)
   */
  function _ensureConnected(cb) {
    if (_setup) {
      cb(null);
      return;
    }

    // Look for an existing Table
    _db.request("DescribeTable", {
      TableName: _tableName
    }, function (err, data) {
      if (err) {
        // In case of Database Error
        if (err.statusCode !== 400) {
          cb(err);
          return;
        }

        // Create the table if it doesn't exist.
        _db.request("CreateTable", _tableSchema, function(err, data) {
          if (err) {
            cb(err);
            return;
          }
          var count = 0;

          // Wait for the Table to have ACTIVE status.
          function waitForCreation() {
            _db.request("DescribeTable", {
              TableName: _tableName
            }, function (err, data) {
              if (err) {
                if (err.statusCode === 400) {
                  if (count < _maxCount) {
                    setTimeout(waitForCreation, 50);
                    return;
                  }
                }
                cb(err);
                return;
              }
              if (data.Table.TableStatus !== "ACTIVE") {
                if (count < _maxCount) {
                  setTimeout(waitForCreation, 50);
                  return;
                }
                cb(new Error("Table is not ACTIVE. STATUS: " +
                             data.Table.TableStatus));
                return;
              }
              _setup = true;
              cb(null);
              return;
            });
          }
          waitForCreation();
        });
        return;
      }

      _setup = true;
      cb(null);
      return;
    });
  }

  /**
   * Convert a JS Object into a DynamoDB Item
   */
  function dynamObject(record) {
    var item = {};

    for (var key in record) {
      var key_type = typeof record[key];

      item[key] = {};

      switch (key_type) {
      case "string":
        item[key].S = record[key];
        break;
      case "number":
        item[key].N = record[key].toString();
        break;
      default:
        throw new Error(key_type + " is not supported yet.");
      }
    }

    return item;
  }

  /**
   * Convert a DynamoDB Item into a JS Object
   */
  function unDynamObject(item) {
    var record = {};
    function reducedDynam(value) {
      record[key] = item[key][value];
    }
    for (var key in item) {
      Object.keys(item[key]).map(reducedDynam);
    }
    return record;
  }

  return {
    /**
     * Returns current name value (read only).
     *
     * @return {String}
     */
    get name() {
      return _settings.name;
    },

    /**
     * Adds a single record to the collection.
     *
     * @param {Object}   record Record Object
     * @param {Function} cb     Callback(err, record)
     */
    add: function(record, cb) {
      _ensureConnected(function(err) {
        if (err) {
          cb(err);
          return;
        }

        var item;

        try {
          item = dynamObject(record);
        } catch (err) {
          cb(err);
          return;
        }

        // Build expected
        var expected = {};
        _options.unique.forEach(function(value) {
          expected[value] = {
            Exists: false
          };
        });

        _db.request("PutItem", {
          Item: item,
          Expected: expected,
          TableName: _tableName
        }, function (err) {
          if (err) {
            cb(err);
            return;
          }
          cb(null, record);
        });
      });
    },


    /**
     * Update all existing records matching the given criteria or create a
     * new one.
     *
     * @param {Object}   criteria Criteria Object
     * @param {Object}   record   Record Object
     * @param {Function} cb       Callback(err)
     */
    updateOrCreate: function(criteria, record, cb) {
      _ensureConnected(function(err) {
        if (err) {
          cb(err);
          return;
        }

        var keys;
        try {
          keys = dynamObject(criteria);
        } catch (err) {
          cb(err);
          return;
        }

        var item;
        try {
          item = dynamObject(record);
        } catch (err) {
          cb(err);
          return;
        }

        for (var key in item) {
          var value = item[key];
          item[key] = {
            Value: value,
            Action: "PUT"
          };
        }

        _db.request("UpdateItem", {
          Key: keys,
          AttributesUpdates: item,
          TableName: _tableName
        }, cb);
      });
    },

    /**
     * Retrieves multiple records matching the provided query object.
     *
     * @param  {Object}   query Query object
     * @param  {Function} cb    Callback(err, record)
     */
    find: function(query, cb) {
      _ensureConnected(function(err) {
        if (err) {
          cb(err);
          return;
        }
        var keys = dynamObject(query);
        var conditions = {};
        for (var key in keys) {
          conditions[key] = {
            AttributeValueList: [keys[key]],
            ComparisonOperator: "EQ"
          };
        }

        _db.request("Query", {
          Select: "ALL_ATTRIBUTES",
          TableName: _tableName,
          KeyConditions: conditions
        }, function (err, data) {
          if (err) {
            cb(err);
            return;
          }

          cb(null, data.Items.map(unDynamObject));
        });
      });
    },

    /**
     * Retrieves the first record matching the provided query object.
     *
     * @param  {Object}   query Query object
     * @param  {Function} cb    Callback(err, record|null)
     */
    findOne: function(query, cb) {
      this.find(query, function(err, records) {
        if (err) {
          cb(err);
          return;
        }
        cb(null, records[0]);
      });
    }.bind(this),

    /**
     * Drops current database.
     * @param  {Function} cb Callback(err)
     */
    drop: function(cb) {
      _ensureConnected(function(err) {
        if (err) {
          cb(err);
          return;
        }

        _db.request("DeleteTable", {
          TableName: _tableName
        }, function(err) {
          if (err) {
            cb(err);
            return;
          }

          function waitForDeletion() {
            _db.request("DescribeTable", {
              TableName: _tableName
            }, function (err, data) {
              if (err) {
                if (err.statusCode === 400) {
                  cb(null);
                  return;
                }
                cb(err);
                return;
              }
              if (count < _maxCount) {
                setTimeout(waitForCreation, 50);
                return;
              }
              cb(new Error("Table is not DELETING. STATUS: " +
                           data.Table.TableStatus));
              return;
            });
          }
          waitForDeletion();
        });
      });
    }
  };
};
