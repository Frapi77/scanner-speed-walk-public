import './style.css'

document.querySelector('#app').innerHTML = `
  <main class="container">
    <h1>Scanner Speed Walk</h1>
    <p class="subtitle">Performative walk at 1008 m/h</p>

    <section class="card">
      <label for="stepLength">Step length (cm)</label>
      <input
        id="stepLength"
        type="number"
        min="1"
        step="0.1"
        placeholder="e.g. 70"
      />

      <label for="sensitivitySlider" style="margin-top: 16px;">Detection sensitivity</label>
      <input
        id="sensitivitySlider"
        type="range"
        min="1"
        max="10"
        step="1"
        value="6"
      />

      <div id="sensitivityInfo" class="result">
        Sensitivity: <strong>6</strong><br>
        Lower = stricter, higher = more reactive<br>
        Threshold: <strong>0.98</strong><br>
        Refractory window: <strong>783 ms</strong>
      </div>

      <div class="buttonRow">
        <button id="calculateBtn">Calculate interval</button>
        <button id="enableMotionBtn">Enable motion</button>
        <button id="enableGpsBtn">Enable GPS</button>
      </div>

      <div class="buttonRow" style="margin-top: 10px;">
        <button id="startCalibrationBtn">Start calibration</button>
        <button id="resetCalibrationBtn">Reset calibration</button>
      </div>

      <div id="calibrationBox" class="result">
        Calibration: <strong>off</strong><br>
        Calibration detected steps: <strong>0</strong><br>
        Motion source: <strong>none</strong><br>
        Walk a few steps and adjust sensitivity until one bodily step gives one count.
      </div>

      <div class="buttonRow" style="margin-top: 10px;">
        <button id="startSessionBtn" disabled>Start session</button>
        <button id="stopSessionBtn" disabled>Stop session</button>
      </div>

      <div class="buttonRow" style="margin-top: 10px;">
        <button id="exportStepCsvBtn" disabled>Export step CSV</button>
        <button id="exportSummaryCsvBtn" disabled>Export summary CSV</button>
        <button id="exportMapBtn" disabled>Export map HTML</button>
      </div>

      <div id="result" class="result">
        Insert your step length and calculate the interval.
      </div>

      <div id="statusBox" class="result">
        Motion: <strong>not enabled</strong><br>
        GPS: <strong>not enabled</strong><br>
        Session: <strong>stopped</strong>
      </div>

      <div id="liveData" class="result">
        Elapsed time: <strong>0.0 s</strong><br>
        Theoretical steps: <strong>0</strong><br>
        Detected steps: <strong>0</strong><br>
        Current misalignment: <strong>0 ms</strong><br>
        Cumulative drift: <strong>0 ms</strong><br>
        Motion signal: <strong>0.000</strong><br>
        GPS points: <strong>0</strong><br>
        Total distance: <strong>0.00 m</strong>
      </div>
    </section>
  </main>
`

const SCANNER_SPEED_M_PER_HOUR = 1008
const SCANNER_SPEED_M_PER_SECOND = SCANNER_SPEED_M_PER_HOUR / 3600

const stepLengthInput = document.querySelector('#stepLength')
const sensitivitySlider = document.querySelector('#sensitivitySlider')
const sensitivityInfo = document.querySelector('#sensitivityInfo')
const calculateBtn = document.querySelector('#calculateBtn')
const enableMotionBtn = document.querySelector('#enableMotionBtn')
const enableGpsBtn = document.querySelector('#enableGpsBtn')
const startCalibrationBtn = document.querySelector('#startCalibrationBtn')
const resetCalibrationBtn = document.querySelector('#resetCalibrationBtn')
const calibrationBox = document.querySelector('#calibrationBox')
const startSessionBtn = document.querySelector('#startSessionBtn')
const stopSessionBtn = document.querySelector('#stopSessionBtn')
const exportStepCsvBtn = document.querySelector('#exportStepCsvBtn')
const exportSummaryCsvBtn = document.querySelector('#exportSummaryCsvBtn')
const exportMapBtn = document.querySelector('#exportMapBtn')
const result = document.querySelector('#result')
const statusBox = document.querySelector('#statusBox')
const liveData = document.querySelector('#liveData')

let intervalSeconds = null
let intervalMs = null
let currentStepLengthCm = null

let cueTimer = null
let liveTimer = null
let initialCueTimeout = null
let audioContext = null

let motionEnabled = false
let gpsEnabled = false
let gpsDenied = false
let sessionRunning = false
let calibrationRunning = false

let startTime = null
let stopTime = null
let theoreticalStepCount = 0
let detectedStepCount = 0
let calibrationDetectedSteps = 0
let currentMisalignmentMs = 0
let cumulativeDriftMs = 0
let motionSignal = 0
let totalDistanceM = 0

let gpsWatchId = null
let latestGps = null
let gpsPointCount = 0

let lastDetectedStepTime = 0
let previousSignal = 0
let smoothedSignal = 0
let gravityBaseline = 9.81

let sensitivity = 6
let peakThreshold = 0.98
let refractoryMs = 783

let motionSource = 'none'

const SIGNAL_SMOOTHING_ALPHA = 0.35
const BASELINE_ALPHA = 0.03

const theoreticalSteps = []
const detectedSteps = []
const matchedRows = []
const gpsTrack = []

function mapSensitivity(value) {
  const v = Number(value)
  const threshold = 1.8 - ((v - 1) / 9) * 1.45
  const refractory = Math.round(1150 - ((v - 1) / 9) * 650)
  return { threshold, refractory }
}

function updateSensitivity() {
  sensitivity = Number(sensitivitySlider.value)
  const mapped = mapSensitivity(sensitivity)
  peakThreshold = mapped.threshold
  refractoryMs = mapped.refractory

  sensitivityInfo.innerHTML = `
    Sensitivity: <strong>${sensitivity}</strong><br>
    Lower = stricter, higher = more reactive<br>
    Threshold: <strong>${peakThreshold.toFixed(2)}</strong><br>
    Refractory window: <strong>${refractoryMs} ms</strong>
  `

  if (intervalSeconds && currentStepLengthCm) {
    const stepsPerMinute = 60 / intervalSeconds
    result.innerHTML = `
      Scanner speed: <strong>${SCANNER_SPEED_M_PER_HOUR} m/h</strong><br>
      Step length: <strong>${currentStepLengthCm.toFixed(1)} cm</strong><br>
      Step interval: <strong>${intervalSeconds.toFixed(2)} s</strong><br>
      Steps per minute: <strong>${stepsPerMinute.toFixed(2)}</strong><br>
      Detection sensitivity: <strong>${sensitivity}</strong><br>
      Threshold: <strong>${peakThreshold.toFixed(2)}</strong><br>
      Refractory window: <strong>${refractoryMs} ms</strong>
    `
  }
}

function updateCalibrationBox() {
  calibrationBox.innerHTML = `
    Calibration: <strong>${calibrationRunning ? 'on' : 'off'}</strong><br>
    Calibration detected steps: <strong>${calibrationDetectedSteps}</strong><br>
    Motion source: <strong>${motionSource}</strong><br>
    Walk a few steps and adjust sensitivity until one bodily step gives one count.
  `
}

function updateStatusBox() {
  let gpsText = 'not enabled'
  if (gpsDenied) gpsText = 'denied'
  else if (gpsEnabled) gpsText = 'enabled'

  statusBox.innerHTML = `
    Motion: <strong>${motionEnabled ? 'enabled' : 'not enabled'}</strong><br>
    GPS: <strong>${gpsText}</strong><br>
    Session: <strong>${sessionRunning ? 'running' : 'stopped'}</strong>
  `
}

function getElapsedTimeMs() {
  if (sessionRunning && startTime) return Date.now() - startTime
  if (!sessionRunning && startTime && stopTime) return stopTime - startTime
  return 0
}

function updateLiveData() {
  const elapsedMs = getElapsedTimeMs()
  const elapsedSeconds = elapsedMs / 1000

  liveData.innerHTML = `
    Elapsed time: <strong>${elapsedSeconds.toFixed(1)} s</strong><br>
    Theoretical steps: <strong>${theoreticalStepCount}</strong><br>
    Detected steps: <strong>${detectedStepCount}</strong><br>
    Current misalignment: <strong>${Math.round(currentMisalignmentMs)} ms</strong><br>
    Cumulative drift: <strong>${Math.round(cumulativeDriftMs)} ms</strong><br>
    Motion signal: <strong>${motionSignal.toFixed(3)}</strong><br>
    GPS points: <strong>${gpsPointCount}</strong><br>
    Total distance: <strong>${totalDistanceM.toFixed(2)} m</strong>
  `
}

function clearSessionTimers() {
  if (cueTimer) {
    clearInterval(cueTimer)
    cueTimer = null
  }
  if (liveTimer) {
    clearInterval(liveTimer)
    liveTimer = null
  }
  if (initialCueTimeout) {
    clearTimeout(initialCueTimeout)
    initialCueTimeout = null
  }
}

function resetSignalState() {
  lastDetectedStepTime = 0
  previousSignal = 0
  smoothedSignal = 0
  gravityBaseline = 9.81
  motionSignal = 0
}

function resetSessionData() {
  startTime = null
  stopTime = null
  theoreticalStepCount = 0
  detectedStepCount = 0
  currentMisalignmentMs = 0
  cumulativeDriftMs = 0
  gpsPointCount = 0
  latestGps = null
  totalDistanceM = 0

  resetSignalState()

  theoreticalSteps.length = 0
  detectedSteps.length = 0
  matchedRows.length = 0
  gpsTrack.length = 0

  updateLiveData()
}

function resetCalibrationData() {
  calibrationDetectedSteps = 0
  resetSignalState()
  updateCalibrationBox()
  updateLiveData()
}

function playBeep() {
  if (!audioContext) return

  const now = audioContext.currentTime
  const oscillator1 = audioContext.createOscillator()
  const oscillator2 = audioContext.createOscillator()
  const gainNode = audioContext.createGain()

  oscillator1.type = 'square'
  oscillator1.frequency.setValueAtTime(1400, now)

  oscillator2.type = 'triangle'
  oscillator2.frequency.setValueAtTime(950, now)

  gainNode.gain.setValueAtTime(0.0001, now)
  gainNode.gain.exponentialRampToValueAtTime(0.45, now + 0.01)
  gainNode.gain.exponentialRampToValueAtTime(0.22, now + 0.07)
  gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.20)

  oscillator1.connect(gainNode)
  oscillator2.connect(gainNode)
  gainNode.connect(audioContext.destination)

  oscillator1.start(now)
  oscillator2.start(now)
  oscillator1.stop(now + 0.20)
  oscillator2.stop(now + 0.20)
}

function getGpsSnapshot() {
  return latestGps
    ? {
        latitude: latestGps.lat,
        longitude: latestGps.lng,
        accuracy: latestGps.acc,
      }
    : {
        latitude: '',
        longitude: '',
        accuracy: '',
      }
}

function pushTheoreticalStep(tsAbsolute) {
  theoreticalStepCount += 1

  theoreticalSteps.push({
    index: theoreticalStepCount,
    absoluteTimeMs: tsAbsolute,
    relativeTimeMs: tsAbsolute - startTime,
    matched: false,
  })

  updateLiveData()
}

function findNearestUnmatchedTheoreticalStep(dsAbsolute) {
  let best = null
  let bestAbsDelta = Infinity

  for (const step of theoreticalSteps) {
    if (step.matched) continue

    const delta = dsAbsolute - step.absoluteTimeMs
    const absDelta = Math.abs(delta)

    if (absDelta < bestAbsDelta) {
      bestAbsDelta = absDelta
      best = step
    }
  }

  return best
}

function registerDetectedStep(dsAbsolute) {
  detectedStepCount += 1
  detectedSteps.push({
    absoluteTimeMs: dsAbsolute,
    relativeTimeMs: dsAbsolute - startTime,
  })

  const nearest = findNearestUnmatchedTheoreticalStep(dsAbsolute)

  if (nearest) {
    nearest.matched = true

    const mi = dsAbsolute - nearest.absoluteTimeMs
    cumulativeDriftMs += mi
    currentMisalignmentMs = mi

    const gps = getGpsSnapshot()

    matchedRows.push({
      theoretical_step_time_from_start_ms: nearest.relativeTimeMs,
      detected_step_time_from_start_ms: dsAbsolute - startTime,
      misalignment_ms: mi,
      gps_latitude: gps.latitude,
      gps_longitude: gps.longitude,
      gps_accuracy_m: gps.accuracy,
      cumulative_drift_ms: cumulativeDriftMs,
    })
  }

  updateLiveData()
}

function getMotionValue(event) {
  const acc = event.acceleration

  if (acc && acc.x != null && acc.y != null && acc.z != null) {
    motionSource = 'acceleration'
    const x = acc.x ?? 0
    const y = acc.y ?? 0
    const z = acc.z ?? 0
    return Math.sqrt(x * x + y * y + z * z)
  }

  const accG = event.accelerationIncludingGravity
  if (accG && accG.x != null && accG.y != null && accG.z != null) {
    motionSource = 'accelerationIncludingGravity'
    const x = accG.x ?? 0
    const y = accG.y ?? 0
    const z = accG.z ?? 0
    const magnitude = Math.sqrt(x * x + y * y + z * z)

    gravityBaseline =
      BASELINE_ALPHA * magnitude + (1 - BASELINE_ALPHA) * gravityBaseline

    return Math.abs(magnitude - gravityBaseline)
  }

  motionSource = 'none'
  return null
}

function handleMotionEvent(event) {
  const rawValue = getMotionValue(event)
  if (rawValue == null) return

  smoothedSignal =
    SIGNAL_SMOOTHING_ALPHA * rawValue +
    (1 - SIGNAL_SMOOTHING_ALPHA) * smoothedSignal

  motionSignal = smoothedSignal

  const now = Date.now()
  const enoughTimePassed = now - lastDetectedStepTime > refractoryMs
  const crossedUp =
    previousSignal <= peakThreshold && motionSignal > peakThreshold

  if (calibrationRunning && crossedUp && enoughTimePassed) {
    lastDetectedStepTime = now
    calibrationDetectedSteps += 1
    updateCalibrationBox()
  }

  if (sessionRunning && crossedUp && enoughTimePassed) {
    lastDetectedStepTime = now
    registerDetectedStep(now)
  }

  previousSignal = motionSignal
  updateCalibrationBox()
  updateLiveData()
}

async function enableMotion() {
  try {
    if (
      typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function'
    ) {
      const permission = await DeviceMotionEvent.requestPermission()
      if (permission !== 'granted') {
        alert('Motion permission denied.')
        return
      }
    }

    window.removeEventListener('devicemotion', handleMotionEvent)
    window.addEventListener('devicemotion', handleMotionEvent)

    motionEnabled = true
    updateStatusBox()
    maybeEnableStart()
  } catch (error) {
    console.error(error)
    alert('Unable to enable motion.')
  }
}

function maybeEnableStart() {
  if (intervalSeconds && motionEnabled) {
    startSessionBtn.disabled = false
  }
}

function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180
  const R = 6371000

  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2)

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

function addGpsPoint(position) {
  const point = {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    acc: position.coords.accuracy,
    absoluteTimeMs: position.timestamp,
    relativeTimeMs: startTime ? position.timestamp - startTime : '',
  }

  if (gpsTrack.length > 0) {
    const prev = gpsTrack[gpsTrack.length - 1]
    totalDistanceM += haversineDistanceMeters(prev.lat, prev.lng, point.lat, point.lng)
  }

  latestGps = point
  gpsTrack.push(point)
  gpsPointCount = gpsTrack.length
  updateLiveData()
}

function enableGps() {
  if (!navigator.geolocation) {
    alert('Geolocation is not supported on this device/browser.')
    return
  }

  gpsDenied = false

  navigator.geolocation.getCurrentPosition(
    (position) => {
      latestGps = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        acc: position.coords.accuracy,
        absoluteTimeMs: position.timestamp,
        relativeTimeMs: '',
      }

      gpsEnabled = true
      updateStatusBox()
      maybeEnableStart()
    },
    (error) => {
      console.error(error)
      gpsEnabled = false
      gpsDenied = true
      updateStatusBox()
      alert('GPS denied or unavailable. Enable location permission for this site in browser settings and try again.')
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000,
    }
  )
}

function startGpsWatch() {
  if (!gpsEnabled || !navigator.geolocation) return

  stopGpsWatch()

  gpsWatchId = navigator.geolocation.watchPosition(
    (position) => {
      addGpsPoint(position)
    },
    (error) => {
      console.error(error)
      gpsEnabled = false
      gpsDenied = true
      stopGpsWatch()
      updateStatusBox()
    },
    {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 10000,
    }
  )
}

function stopGpsWatch() {
  if (gpsWatchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(gpsWatchId)
    gpsWatchId = null
  }
}

function startCalibration() {
  if (!motionEnabled || sessionRunning) return
  calibrationRunning = true
  resetCalibrationData()
  updateCalibrationBox()
}

function resetCalibration() {
  calibrationRunning = false
  resetCalibrationData()
  updateCalibrationBox()
}

async function startSession() {
  if (!intervalMs || !motionEnabled || sessionRunning) return

  calibrationRunning = false
  updateCalibrationBox()

  clearSessionTimers()
  resetSessionData()

  sessionRunning = true
  startTime = Date.now()
  stopTime = null

  if (!audioContext) {
    audioContext = new window.AudioContext()
  }

  if (audioContext.state === 'suspended') {
    await audioContext.resume()
  }

  playBeep()

  initialCueTimeout = setTimeout(() => {
    if (!sessionRunning) return

    pushTheoreticalStep(startTime)

    cueTimer = setInterval(() => {
      if (!sessionRunning) return
      playBeep()
      pushTheoreticalStep(Date.now())
    }, intervalMs)

    liveTimer = setInterval(() => {
      updateLiveData()
    }, 100)
  }, 120)

  startGpsWatch()

  startSessionBtn.disabled = true
  stopSessionBtn.disabled = false
  exportStepCsvBtn.disabled = true
  exportSummaryCsvBtn.disabled = true
  exportMapBtn.disabled = true

  updateStatusBox()
  updateLiveData()
}

function stopSession() {
  sessionRunning = false
  stopTime = Date.now()

  clearSessionTimers()
  stopGpsWatch()

  startSessionBtn.disabled = false
  stopSessionBtn.disabled = true

  const hasAnyData = matchedRows.length > 0 || gpsTrack.length > 0 || theoreticalStepCount > 0
  exportStepCsvBtn.disabled = matchedRows.length === 0
  exportSummaryCsvBtn.disabled = !hasAnyData
  exportMapBtn.disabled = gpsTrack.length === 0

  updateStatusBox()
  updateLiveData()
}

function downloadTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function makeTimestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function exportStepCsv() {
  if (matchedRows.length === 0) {
    alert('No matched step data to export yet.')
    return
  }

  const header = [
    'theoretical_step_time_from_start_ms',
    'detected_step_time_from_start_ms',
    'misalignment_ms',
    'gps_latitude',
    'gps_longitude',
    'gps_accuracy_m',
    'cumulative_drift_ms',
  ]

  const lines = [
    header.join(','),
    ...matchedRows.map((row) =>
      [
        row.theoretical_step_time_from_start_ms,
        row.detected_step_time_from_start_ms,
        row.misalignment_ms,
        row.gps_latitude,
        row.gps_longitude,
        row.gps_accuracy_m,
        row.cumulative_drift_ms,
      ].join(',')
    ),
  ]

  downloadTextFile(
    `step_data_${makeTimestampLabel()}.csv`,
    lines.join('\n'),
    'text/csv;charset=utf-8;'
  )
}

function exportSummaryCsv() {
  const elapsedMs = getElapsedTimeMs()
  const elapsedS = elapsedMs / 1000

  const summary = [
    ['metric', 'value'],
    ['scanner_speed_m_per_hour', SCANNER_SPEED_M_PER_HOUR],
    ['step_length_cm', currentStepLengthCm ?? ''],
    ['detection_sensitivity', sensitivity],
    ['detection_threshold', peakThreshold.toFixed(2)],
    ['detection_refractory_window_ms', refractoryMs],
    ['total_theoretical_steps', theoreticalStepCount],
    ['total_detected_steps', detectedStepCount],
    ['total_performance_time_ms', Math.round(elapsedMs)],
    ['total_performance_time_s', elapsedS.toFixed(2)],
    ['total_distance_m', totalDistanceM.toFixed(2)],
    ['final_cumulative_drift_ms', Math.round(cumulativeDriftMs)],
    ['gps_points_collected', gpsPointCount],
    ['motion_source', motionSource],
  ]

  const csv = summary.map((row) => row.join(',')).join('\n')

  downloadTextFile(
    `performance_summary_${makeTimestampLabel()}.csv`,
    csv,
    'text/csv;charset=utf-8;'
  )
}

function exportMapHtml() {
  if (gpsTrack.length === 0) {
    alert('No GPS track to export yet.')
    return
  }

  const points = gpsTrack.map((p, index) => ({
    lat: p.lat,
    lng: p.lng,
    acc: p.acc,
    idx: index + 1,
    relativeTimeMs: p.relativeTimeMs,
  }))

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Scanner-Speed Walk Map</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin=""/>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; font-family: Arial, sans-serif; }
    #map { width: 100%; height: 100vh; }
    .legend {
      background: rgba(255,255,255,0.95);
      padding: 10px 12px;
      border-radius: 8px;
      box-shadow: 0 1px 8px rgba(0,0,0,0.15);
      line-height: 1.4;
      font-size: 14px;
    }
    .legend .swatch {
      display: inline-block;
      width: 18px;
      height: 3px;
      vertical-align: middle;
      margin-right: 6px;
      background: #1d4ed8;
    }
  </style>
</head>
<body>
  <div id="map"></div>

  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>
  <script>
    const points = ${JSON.stringify(points)};
    const map = L.map('map');
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    const latlngs = points.map(p => [p.lat, p.lng]);
    const line = L.polyline(latlngs, {
      color: '#1d4ed8',
      weight: 4,
      opacity: 0.9
    }).addTo(map);

    const start = points[0];
    const end = points[points.length - 1];

    L.circleMarker([start.lat, start.lng], {
      radius: 7,
      color: '#15803d',
      fillColor: '#22c55e',
      fillOpacity: 0.95,
      weight: 2
    }).addTo(map).bindPopup('Start');

    L.circleMarker([end.lat, end.lng], {
      radius: 7,
      color: '#991b1b',
      fillColor: '#ef4444',
      fillOpacity: 0.95,
      weight: 2
    }).addTo(map).bindPopup('End');

    points.forEach(p => {
      L.circleMarker([p.lat, p.lng], {
        radius: 3,
        color: '#111827',
        fillColor: '#111827',
        fillOpacity: 0.85,
        weight: 1
      }).addTo(map).bindPopup(
        'Point ' + p.idx +
        (p.relativeTimeMs !== '' ? '<br>Time from start: ' + p.relativeTimeMs + ' ms' : '') +
        (p.acc != null ? '<br>GPS accuracy: ' + Number(p.acc).toFixed(1) + ' m' : '')
      );

      if (p.acc != null && p.acc > 0) {
        L.circle([p.lat, p.lng], {
          radius: p.acc,
          color: '#6b7280',
          weight: 1,
          opacity: 0.25,
          fillOpacity: 0.03
        }).addTo(map);
      }
    });

    map.fitBounds(line.getBounds(), { padding: [30, 30] });

    const legend = L.control({ position: 'topright' });
    legend.onAdd = function() {
      const div = L.DomUtil.create('div', 'legend');
      div.innerHTML = \`
        <div><span class="swatch"></span> GPS trace</div>
        <div><strong>Green</strong>: start</div>
        <div><strong>Red</strong>: end</div>
        <div style="margin-top: 6px; font-size: 12px;">
          Accuracy circles are shown in meters when available.
        </div>
      \`;
      return div;
    };
    legend.addTo(map);
  </script>
</body>
</html>`

  downloadTextFile(
    `performance_map_${makeTimestampLabel()}.html`,
    html,
    'text/html;charset=utf-8;'
  )
}

calculateBtn.addEventListener('click', () => {
  const stepLengthCm = Number(stepLengthInput.value)

  if (!stepLengthCm || stepLengthCm <= 0) {
    result.textContent = 'Please enter a valid step length in centimeters.'
    startSessionBtn.disabled = true
    stopSessionBtn.disabled = true
    return
  }

  currentStepLengthCm = stepLengthCm

  const stepLengthM = stepLengthCm / 100
  intervalSeconds = stepLengthM / SCANNER_SPEED_M_PER_SECOND
  intervalMs = intervalSeconds * 1000
  const stepsPerMinute = 60 / intervalSeconds

  result.innerHTML = `
    Scanner speed: <strong>${SCANNER_SPEED_M_PER_HOUR} m/h</strong><br>
    Step length: <strong>${stepLengthCm.toFixed(1)} cm</strong><br>
    Step interval: <strong>${intervalSeconds.toFixed(2)} s</strong><br>
    Steps per minute: <strong>${stepsPerMinute.toFixed(2)}</strong><br>
    Detection sensitivity: <strong>${sensitivity}</strong><br>
    Threshold: <strong>${peakThreshold.toFixed(2)}</strong><br>
    Refractory window: <strong>${refractoryMs} ms</strong>
  `

  maybeEnableStart()
})

sensitivitySlider.addEventListener('input', updateSensitivity)
enableMotionBtn.addEventListener('click', enableMotion)
enableGpsBtn.addEventListener('click', enableGps)
startCalibrationBtn.addEventListener('click', startCalibration)
resetCalibrationBtn.addEventListener('click', resetCalibration)
startSessionBtn.addEventListener('click', startSession)
stopSessionBtn.addEventListener('click', stopSession)
exportStepCsvBtn.addEventListener('click', exportStepCsv)
exportSummaryCsvBtn.addEventListener('click', exportSummaryCsv)
exportMapBtn.addEventListener('click', exportMapHtml)

updateSensitivity()
updateCalibrationBox()
updateStatusBox()
updateLiveData()
