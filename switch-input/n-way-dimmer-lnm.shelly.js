/**
 * @title n-way-dimmer-lnm.shelly.js
 * @description Setup an N-Way dimmer group using Shelly Local Network Messaging.
 *   Devices broadcast light status using LNM and mirror remote state changes locally.
 * @status 
 * @link https://github.com/ALLTERCO/shelly-script-examples/blob/main/switch-input/n-way-dimmer-lnm.shelly.js
 */

/**
 * Local Network Messaging N-Way Dimmer Example
 *
 * Requirements:
 * - Shelly firmware with LNM support
 * - Same multicast address/port on every device in the group
 * - Enable TX for the local light component on each sender
 * - Enable RX on each receiver so scripts can mirror incoming state
 *
 * This script validates an existing LNM instance, and mirrors received light
 * status from the network to the local light component.
 *
 * The LNM instance must be created and configured externally before the
 * script runs. The script checks the existing instance and refuses to proceed
 * if LNM is not available or not configured correctly.
 *
 * This example broadcasts light status using LNM and mirrors received
 * remote light state locally.
 *
 * Example external setup calls (replace DEVICE_IP and instance id as needed):
 *
 *   http://DEVICE_IP/rpc/LNM.Create?config={"addr":"239.255.0.1:3333"}
 *
 * Then configure the instance:
 *
 *   http://DEVICE_IP/rpc/LNM.SetConfig?id=200&config={"tx":{"enable":true,"components":["light:0"]},"rx":{"enable":true},"rpc_enable":true}
 *
 * `rpc_enable=true` is required for this script because it uses `LNM.Call` to broadcast
 * `Light.Set` commands across the group.
 */

var CONFIG = {
  lnmInstanceId: 200,
  senderId: '',
  sourceKey: 'light:0',
  targetId: 0,
  switchGroup: 'default',
};

var suppressSend = false;
var lastLocalState = { on: null, brightness: null };
var lastSentState = { on: null, brightness: null };

function getSwitchGroupFromDeviceName(name) {
  if (typeof name !== 'string') {
    return CONFIG.switchGroup;
  }
  var openIndex = name.indexOf('(');
  if (openIndex === -1) {
    return CONFIG.switchGroup;
  }
  var closeIndex = name.indexOf(')', openIndex + 1);
  if (closeIndex === -1 || closeIndex <= openIndex + 1) {
    return CONFIG.switchGroup;
  }
  var groupName = name.substring(openIndex + 1, closeIndex);
  if (typeof groupName !== 'string' || groupName.length === 0) {
    return CONFIG.switchGroup;
  }
  return groupName.trim();
}

function setSwitchGroupFromDeviceName() {
  var sysConfig = Shelly.getComponentConfig('sys');
  if (!sysConfig || !sysConfig.device || typeof sysConfig.device.name !== 'string') {
    log('Could not read sys device name, using default switchGroup:', CONFIG.switchGroup);
    return;
  }
  var name = sysConfig.device.name;
  CONFIG.switchGroup = getSwitchGroupFromDeviceName(name);
  log('Derived switchGroup from device name:', name, '->', CONFIG.switchGroup);
}

function log() {
  var msg = '[n-way-dimmer-lnm]';
  for (var i = 0; i < arguments.length; i++) {
    msg += ' ' + arguments[i];
  }
  print(msg);
}

function getLocalLightState() {
  var status = Shelly.getComponentStatus('light', CONFIG.targetId);
  if (!status) {
    return { on: false, brightness: 0 };
  }
  return {
    on: status.output,
    brightness: typeof status.brightness === 'number' ? status.brightness : 0,
  };
}

function sendLocalState() {
  if (suppressSend) {
    return;
  }

  var state = getLocalLightState();
  if (statesEqual(state, lastSentState)) {
    log('Local state unchanged since last send, skipping LNM broadcast:', JSON.stringify(state));
    return;
  }

  var params = { id: CONFIG.targetId, on: state.on };
  if (typeof state.brightness === 'number') {
    params.brightness = state.brightness;
  }

  var lnmCall = { id: CONFIG.lnmInstanceId, method: 'Light.Set', params: params };

  log('Broadcasting local light state via LNM.Call:', JSON.stringify(lnmCall));
  Shelly.call('LNM.Call', lnmCall, function (result, errCode, errMsg) {
    if (errCode !== 0) {
      log('LNM.Call failed:', errCode, errMsg);
      if (errCode === 404) {
        log('LNM.Call not supported. Make sure RPC is enabled on the LNM instance.');
      }
    }
  });
}

function handleLocalLight(ev) {
  if (ev.name !== 'light' || ev.component !== 'light:' + CONFIG.targetId || !ev.delta) {
    return;
  }
  if (suppressSend) {
    log('Local light update caused by remote mirror, suppressing LNM broadcast');
    return;
  }

  var state = getLocalLightState();
  if (statesEqual(state, lastLocalState)) {
    log('Local light state already reflected from remote update, skipping broadcast:', JSON.stringify(state));
    return;
  }

  lastLocalState = { on: state.on, brightness: state.brightness };
  log('Local light changed, broadcasting via LNM:', CONFIG.sourceKey);
  sendLocalState();
}

function statesEqual(a, b) {
  return a && b && a.on === b.on && a.brightness === b.brightness;
}

function applyRemoteLightState(source) {
  var state = {
    on: source.output,
    brightness: typeof source.brightness === 'number' ? source.brightness : getLocalLightState().brightness,
  };

  if (statesEqual(state, getLocalLightState())) {
    return;
  }

  log('Applying remote light state:', JSON.stringify(state));
  suppressSend = true;
  lastLocalState = { on: state.on, brightness: state.brightness };
  Shelly.call('Light.Set', { id: CONFIG.targetId, on: state.on, brightness: state.brightness }, function (result, errCode, errMsg) {
    if (errCode !== 0) {
      log('Light.Set failed:', errCode, errMsg);
    }
    Timer.set(250, false, function () {
      suppressSend = false;
    });
  });
}

function handleLnmEvent(ev) {
  if (ev.name !== 'lnm' || !ev.info || ev.info.event !== 'rx') {
    return;
  }

  if (CONFIG.senderId && ev.info.device !== CONFIG.senderId) {
    return;
  }

  var status = ev.info.status;
  if (!status || !status[CONFIG.sourceKey]) {
    return;
  }

  var source = status[CONFIG.sourceKey];
  if (typeof source.output !== 'boolean') {
    return;
  }

  log('Received LNM remote light state:', JSON.stringify(source), 'from device:', ev.info.device);

  applyRemoteLightState(source);
}

function validateLnm(callback) {
  Shelly.call('LNM.GetConfig', { id: CONFIG.lnmInstanceId }, function (result, errCode, errMsg) {
    if (errCode !== 0) {
      log('LNM.GetConfig failed:', errCode, errMsg);
      if (errCode === 404) {
        log('LNM is not available or the instance is missing. Ensure the LNM instance exists and the component is available.');
      }
      return callback(false);
    }

    log('LNM instance config:', JSON.stringify(result));
    var cfg = result.config || result;
    if (!cfg) {
      log('Unexpected LNM GetConfig response.');
      return callback(false);
    }

    if (cfg.tx && cfg.tx.enable === false) {
      log('Warning: LNM TX is disabled. Local light status will not be broadcast.');
    }
    if (cfg.rx && cfg.rx.enable === false) {
      log('Warning: LNM RX is disabled. Remote status will not be received.');
    }
    if (cfg.tx && cfg.tx.components && cfg.tx.components.indexOf(CONFIG.sourceKey) === -1) {
      log('Warning: LNM TX is not sending', CONFIG.sourceKey, 'component.');
    }

    callback(true);
  });
}

function init() {
  log('Starting N-Way Dimmer LNM script');

  setSwitchGroupFromDeviceName();

  var wifiStatus = Shelly.getComponentStatus('Wifi');
  if (!wifiStatus || wifiStatus.status !== 'got ip') {
    log('Warning: device has no Wi-Fi IP address yet. LNM requires local network connectivity.');
  }

  validateLnm(function (ok) {
    if (!ok) {
      log('LNM validation failed. The script cannot proceed until LNM is configured externally.');
      return;
    }

    Shelly.addStatusHandler(handleLocalLight);
    Shelly.addEventHandler(handleLnmEvent);
    log('Registered local light status and LNM event handlers.');
  });
}

init();
