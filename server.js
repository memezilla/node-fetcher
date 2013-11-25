require('nodetime').profile({
  accountKey: '7724d01175fed4cb54a011b85769b7b58a15bf6d', 
  appName: 'node-fetcher'
});

var express = require('express');
var app = express();
var http = require('http');
var async = require('async');
var _ = require('underscore');
var request = require('request');
var util = require('util');
var memwatch = require('memwatch');

app.use(express.logger());

var port = process.env.PORT || 4000;

app.listen(port, function() {
  console.log('Server listening on %s', port);
});

memwatch.on('leak', function(info) {
  console.error('[MEMORY LEAK]' + JSON.stringify(info));
  process.exit(1);
});

var resourceVersions = {};
const resourceDefaultVersion = -1;
const dataRequestingServerURL = process.env.DATA_REQUESTING_SERVER_URL || 'http://node-socketio.herokuapp.com/broadcast/';
const dataProviderHost = process.env.DATA_PROVIDER_HOST || 'node-dataprovider.herokuapp.com';
const dataProviderPort = process.env.DATA_PROVIDER_PORT || 80;
const fetchingJobTimeoutInMilis = 2000;
const defaultResourceMaxAgeInMilis = 5000;
var fetchJobLocked = false;
const authorizationHeaderKey = 'bm9kZS13ZWJzb2NrZXQ=';
const nodeWebSocketAuthorizationHeaderKey = 'bm9kZS1mZXRjaGVy';
var fetchDataRequestOptions = {
    host: dataProviderHost,
    port: dataProviderPort,
    method: 'GET'
  };

/**
 * Public Endpoints
 */

// Receive data fetch requests 
app.get('/fetchlist/new/?*', function(req, res) {
  // Security
  if (req.header('Authorization') !== authorizationHeaderKey) {
    var ip = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || req.connection.socket.remoteAddress;

    console.warn('Unknown server (%s) tried to add a new key to fetch list', ip);

    res.writeHead(403, {
      'Content-Type': 'text/plain'
    }); 
    res.shouldKeepAlive = false;
    res.write('You are not allowed to get data from this server\n');
    res.end();
    return;
  }

  handleResourceRequest(req, res);
});

// Send new resource data to websocket client - or any other server
function broadcastResourceData(updatedResource, resourceId) {
  console.log('Broadcasting new resource data for resource %s', resourceId);

  request({
      uri: dataRequestingServerURL + resourceId,
      method: 'POST',
      form: {
        newResourceData: JSON.stringify(updatedResource)
      },
      headers: {
        Authorization: nodeWebSocketAuthorizationHeaderKey
      }
    }, function(error, response, body) {
      if (!error && response.statusCode == 200) {
        console.log('Successfully broadcasted resource (id: %s) request message to %s', 
          resourceId, dataRequestingServerURL + resourceId); 
      } else {
        console.error('[WARNING] Can not broadcast resource request message to %s: %s', 
          dataRequestingServerURL + resourceId, error);
      }
    });
}

app.get('/', function(req, res){
  var body = 'node-fetcher';
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Length', body.length);
  res.end(body);
});

/**
 * Implementation of public endpoints
 */

function handleResourceRequest(req, res) {
  var resourceId = req.params[0];

  if(!resourceId) {
    console.warn('Bad Request: Invalid parameters');
    res.statusCode = 400;
    return res.send('Bad Request');
  }

  if (resourceVersions[resourceId]) {
    // This can only happen if websocket server is restarted. 
    console.warn('This resource (%s) data is in the fetchlist already, defaulting the version', resourceId);
  }

  resourceVersions[resourceId] = resourceDefaultVersion;

  console.log('Successfully added resource (id: %s) to the fetchlist. Current fetchlist:', resourceId);
  console.log(JSON.stringify(resourceVersions, null, 4));

  // trigger a fetch
  process.nextTick(function() {
      fetchResource(resourceId, releaseFetchJobLock);
  });  

  res.statusCode = 200;
  res.send('Success');  
}

var fetchResource = function (resourceId, callback) { 
  fetchDataRequestOptions.path = '/' + resourceId;
  
  console.log('[BEGIN %s] Fetching datafrom %s:%s', resourceId, dataProviderHost, dataProviderPort);

  var handleReceivedResource = function(res) {
    var updatedResourceInJSON = '';
    res.setEncoding('utf8');

    // Append data as we receive it 
    res.on('data', function (chunk) {
      updatedResourceInJSON += chunk;
      console.log('Received some data from data source: %s', updatedResourceInJSON);
    });

      // When all data is received, check its version and broadcast it if received version is greater
    res.on('end', function() {
      var updatedResource;
      try {
        updatedResource = JSON.parse(updatedResourceInJSON);
      } catch (e) {
        console.error('Did not receive proper JSON object from data provider for resource %s', resourceId);
        return;
      }

      var existingVersion = resourceVersions[resourceId];
      var newVersion = updatedResource.version;

      // if there is verson information, compare the versions and broadcast if data is newer
      if (isNumber(existingVersion) && isNumber(newVersion) && newVersion > existingVersion) {
        console.log('Changes detected for resource %s, current version is %s, new version is %s with a max age of %s miliseconds', 
          resourceId, existingVersion, newVersion, updatedResource.maxAgeInMilis);  

        resourceVersions[resourceId] = updatedResource.version; // update the version
        
        broadcastResourceData(updatedResource, resourceId);
        
      } else if (isNumber(existingVersion) && isNumber(newVersion) && newVersion <= existingVersion){
        console.log('No changes detected for resource %s, current version is %s, new version is %s', 
          resourceId, existingVersion, newVersion);  
      } else {
        console.warn('No valid version information detected (current: %s, new: %s), broadcasting the data.',
          existingVersion, newVersion);
        broadcastResourceData(updatedResource, resourceId);
      }

      console.log('All data for resource %s has been received', resourceId);

      // if the resource is termianted, remove it from the list
      if (updatedResource.terminated === true) {
        console.log('Resource appears to be terminated, removing it from the list');
        delete resourceVersions[resourceId];
      } else {
        var maxAgeForThisResourceInMilis = updatedResource.maxAgeInMilis ? updatedResource.maxAgeInMilis : defaultResourceMaxAgeInMilis;

        setTimeout(function fetchThisResourceRecursively() {
          fetchResource(resourceId, null);
        }, maxAgeForThisResourceInMilis); 
      }

      if (callback) {
        callback();
      }
    });

    res.on('error', function(e) {
      fetchJobLocked = false; 
      console.error('Can not parse resource data: %s', e.message);
    });
  }

  http.get(fetchDataRequestOptions, handleReceivedResource).on('error', releaseFetchJobLock); 
}

var releaseFetchJobLock = function(err) {
  if (err) {
    console.error('[ERROR] Cant fetch resource data: %s', err);  
  } 
    
  fetchJobLocked = false; 
  console.log('[COMPLETE] Data fetch is complete'); 
}

function isEmpty(obj) {
    return Object.keys(obj).length === 0;
}

function isNumber(n) {
  return !isNaN(parseFloat(n)) && isFinite(n);
}