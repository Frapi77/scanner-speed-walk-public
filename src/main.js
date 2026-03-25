import './style.css'

document.querySelector('#app').innerHTML = `
  <main class="container">
    <h1>Scanner Speed Walk</h1>
    <p class="subtitle">Performative walk at 882 m/h</p>

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
        <button id="exportCsvBtn" disabled>Export CSV</button>
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
        Current MI: <strong>0 ms</strong><br>
        Cumulative drift: <strong>0 ms</strong><br>
        Motion signal: <strong>0.000</strong><br>
        GPS points: <strong>0</strong>
      </div>
    </section>
  </main>
`

const SCANNER_SPEED_M_PER_HOUR = 882
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
const exportCsvBtn = document.querySelector('#exportCsvBtn')
const result = document.querySelector('#result')
const statusBox = document.querySelector('#statusBox')
const liveData = document.querySelector('#liveData')

let intervalSeconds = null
let intervalMs = null

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
let theoreticalStepCount = 0
let detectedStepCount = 0
let calibrationDetectedSteps = 0
let currentMisalignmentMs = 0
let cumulativeDriftMs = 0
let motionSignal = 0

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
  const threshold = 1.8 - ((v - 1) / 9) * 1.45   // ~1.8 -> 0.35
  const refractory = Math.round(1150 - ((v - 1) / 9) * 650) // 1150 -> 500
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

  if (intervalSeconds) {
    const stepLengthCm = Number(stepLengthInput.value)
    if (stepLengthCm > 0) {
      const stepsPerMinute = 60 / intervalSeconds
      result.innerHTML = `
        Scanner speed: <strong>882 m/h</strong><br>
        Step length: <strong>${stepLengthCm.toFixed(1)} cm</strong><br>
        Step interval: <strong>${intervalSeconds.toFixed(2)} s</strong><br>
        Steps per minute: <strong>${stepsPerMinute.toFixed(2)}</strong><br>
        Detection sensitivity: <strong>${sensitivity}</strong><br>
        Threshold: <strong>${peakThreshold.toFixed(2)}</strong><br>
        Refractory window: <strong>${refractoryMs} ms</strong>
      `
    }
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

function updateLiveData() {
  const elapsedSeconds =
    startTime && sessionRunning ? (Date.now() - startTime) / 1000 : 0

  liveData.innerHTML = `
    Elapsed time: <strong>${elapsedSeconds.toFixed(1)} s</strong><br>
    Theoretical steps: <strong>${theoreticalStepCount}</strong><br>
    Detected steps: <strong>${detectedStepCount}</strong><br>
    Current MI: <strong>${Math.round(currentMisalignmentMs)} ms</strong><br>
    Cumulative drift: <strong>${Math.round(cumulativeDriftMs)} ms</strong><br>
    Motion signal: <strong>${motionSignal.toFixed(3)}</strong><br>
    GPS points: <strong>${gpsPointCount}</strong>
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
  theoreticalStepCount = 0
  detectedStepCount = 0
  currentMisalignmentMs = 0
  cumulativeDriftMs = 0
  gpsPointCount = 0
  latestGps = null

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
        lat: latestGps.lat,
        lng: latestGps.lng,
        acc: latestGps.acc,
      }
    : {
        lat: '',
        lng: '',
        acc: '',
      }
}

function pushTheoreticalStep(ts) {
  theoreticalStepCount += 1

  theoreticalSteps.push({
    index: theoreticalStepCount,
    ts,
    matched: false,
  })

  updateLiveData()
}

function findNearestUnmatchedTheoreticalStep(ds) {
  let best = null
  let bestAbsDelta = Infinity

  for (const step of theoreticalSteps) {
    if (step.matched) continue

    const delta = ds - step.ts
    const absDelta = Math.abs(delta)

    if (absDelta < bestAbsDelta) {
      bestAbsDelta = absDelta
      best = step
    }
  }

  return best
}

function registerDetectedStep(ds) {
  detectedStepCount += 1
  detectedSteps.push({ ds })

  const nearest = findNearestUnmatchedTheoreticalStep(ds)

  if (nearest) {
    nearest.matched = true

    const mi = ds - nearest.ts
    cumulativeDriftMs += mi
    currentMisalignmentMs = mi

    const gps = getGpsSnapshot()

    matchedRows.push({
      TS: nearest.ts,
      DS: ds,
      MI: mi,
      GPS_LAT: gps.lat,
      GPS_LNG: gps.lng,
      GPS_ACC: gps.acc,
      CD: cumulativeDriftMs,
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
        timestamp: position.timestamp,
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

function maybeEnableStart() {
  if (intervalSeconds && motionEnabled) {
    startSessionBtn.disabled = false
  }
}

function startGpsWatch() {
  if (!gpsEnabled || !navigator.geolocation) return

  stopGpsWatch()

  gpsWatchId = navigator.geolocation.watchPosition(
    (position) => {
      latestGps = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        acc: position.coords.accuracy,
        timestamp: position.timestamp,
      }

      gpsTrack.push(latestGps)
      gpsPointCount += 1
      updateLiveData()
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
  exportCsvBtn.disabled = true
  updateStatusBox()
  updateLiveData()
}

function stopSession() {
  sessionRunning = false
  clearSessionTimers()
  stopGpsWatch()

  startTime = null
  currentMisalignmentMs = 0
  motionSignal = 0

  startSessionBtn.disabled = false
  stopSessionBtn.disabled = true
  exportCsvBtn.disabled = matchedRows.length === 0

  updateStatusBox()
  updateLiveData()
}

function exportCsv() {
  if (matchedRows.length === 0) {
    alert('No matched step data to export yet.')
    return
  }

  const header = ['TS', 'DS', 'MI', 'GPS_LAT', 'GPS_LNG', 'GPS_ACC', 'CD']

  const lines = [
    header.join(','),
    ...matchedRows.map((row) =>
      [
        row.TS,
        row.DS,
        row.MI,
        row.GPS_LAT,
        row.GPS_LNG,
        row.GPS_ACC,
        row.CD,
      ].join(',')
    ),
  ]

  const csvContent = lines.join('\n')
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')

  a.href = url
  a.download = `scanner-speed-walk-${timestamp}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

calculateBtn.addEventListener('click', () => {
  const stepLengthCm = Number(stepLengthInput.value)

  if (!stepLengthCm || stepLengthCm <= 0) {
    result.textContent = 'Please enter a valid step length in centimeters.'
    startSessionBtn.disabled = true
    stopSessionBtn.disabled = true
    return
  }

  const stepLengthM = stepLengthCm / 100
  intervalSeconds = stepLengthM / SCANNER_SPEED_M_PER_SECOND
  intervalMs = intervalSeconds * 1000
  const stepsPerMinute = 60 / intervalSeconds

  result.innerHTML = `
    Scanner speed: <strong>882 m/h</strong><br>
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
exportCsvBtn.addEventListener('click', exportCsv)

updateSensitivity()
updateCalibrationBox()
updateStatusBox()
updateLiveData()
