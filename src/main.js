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

      <div class="buttonRow">
        <button id="calculateBtn">Calculate interval</button>
        <button id="enableMotionBtn">Enable motion</button>
        <button id="enableGpsBtn">Enable GPS</button>
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
        Motion magnitude: <strong>0.000</strong><br>
        GPS points: <strong>0</strong>
      </div>
    </section>
  </main>
`

const SCANNER_SPEED_M_PER_HOUR = 882
const SCANNER_SPEED_M_PER_SECOND = SCANNER_SPEED_M_PER_HOUR / 3600

const stepLengthInput = document.querySelector('#stepLength')
const calculateBtn = document.querySelector('#calculateBtn')
const enableMotionBtn = document.querySelector('#enableMotionBtn')
const enableGpsBtn = document.querySelector('#enableGpsBtn')
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
let audioContext = null

let motionEnabled = false
let gpsEnabled = false
let sessionRunning = false

let startTime = null
let theoreticalStepCount = 0
let detectedStepCount = 0
let currentMisalignmentMs = 0
let cumulativeDriftMs = 0
let motionMagnitude = 0

let gpsWatchId = null
let latestGps = null
let gpsPointCount = 0

let lastDetectedStepTime = 0
let peakThreshold = 1.2
let refractoryMs = 450

const theoreticalSteps = []
const detectedSteps = []
const matchedRows = []
const gpsTrack = []

function updateStatusBox() {
  statusBox.innerHTML = `
    Motion: <strong>${motionEnabled ? 'enabled' : 'not enabled'}</strong><br>
    GPS: <strong>${gpsEnabled ? 'enabled' : 'not enabled'}</strong><br>
    Session: <strong>${sessionRunning ? 'running' : 'stopped'}</strong>
  `
}

function updateLiveData() {
  const elapsedSeconds = startTime ? (Date.now() - startTime) / 1000 : 0

  liveData.innerHTML = `
    Elapsed time: <strong>${elapsedSeconds.toFixed(1)} s</strong><br>
    Theoretical steps: <strong>${theoreticalStepCount}</strong><br>
    Detected steps: <strong>${detectedStepCount}</strong><br>
    Current MI: <strong>${Math.round(currentMisalignmentMs)} ms</strong><br>
    Cumulative drift: <strong>${Math.round(cumulativeDriftMs)} ms</strong><br>
    Motion magnitude: <strong>${motionMagnitude.toFixed(3)}</strong><br>
    GPS points: <strong>${gpsPointCount}</strong>
  `
}

function resetSessionData() {
  startTime = null
  theoreticalStepCount = 0
  detectedStepCount = 0
  currentMisalignmentMs = 0
  cumulativeDriftMs = 0
  motionMagnitude = 0
  gpsPointCount = 0
  latestGps = null
  lastDetectedStepTime = 0

  theoreticalSteps.length = 0
  detectedSteps.length = 0
  matchedRows.length = 0
  gpsTrack.length = 0

  updateLiveData()
}

function playBeep() {
  if (!audioContext) return

  const oscillator = audioContext.createOscillator()
  const gainNode = audioContext.createGain()

  oscillator.type = 'sine'
  oscillator.frequency.value = 880

  gainNode.gain.setValueAtTime(0.0001, audioContext.currentTime)
  gainNode.gain.exponentialRampToValueAtTime(0.15, audioContext.currentTime + 0.01)
  gainNode.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.08)

  oscillator.connect(gainNode)
  gainNode.connect(audioContext.destination)

  oscillator.start()
  oscillator.stop(audioContext.currentTime + 0.08)
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

  playBeep()
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

function handleMotionEvent(event) {
  const acc = event.accelerationIncludingGravity || event.acceleration
  if (!acc) return

  const x = acc.x ?? 0
  const y = acc.y ?? 0
  const z = acc.z ?? 0

  motionMagnitude = Math.sqrt(x * x + y * y + z * z)

  if (!sessionRunning) {
    updateLiveData()
    return
  }

  const now = Date.now()
  const enoughTimePassed = now - lastDetectedStepTime > refractoryMs

  if (motionMagnitude > peakThreshold && enoughTimePassed) {
    lastDetectedStepTime = now
    registerDetectedStep(now)
  }

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

  gpsEnabled = true
  updateStatusBox()
  maybeEnableStart()
}

function maybeEnableStart() {
  if (intervalSeconds && motionEnabled) {
    startSessionBtn.disabled = false
  }
}

function startGpsWatch() {
  if (!gpsEnabled || !navigator.geolocation) return

  if (gpsWatchId !== null) {
    navigator.geolocation.clearWatch(gpsWatchId)
    gpsWatchId = null
  }

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
      alert('GPS error: ' + error.message)
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

function startSession() {
  if (!intervalMs || !motionEnabled) return

  resetSessionData()
  sessionRunning = true
  startTime = Date.now()

  if (!audioContext) {
    audioContext = new window.AudioContext()
  }

  const startAudio = async () => {
    if (audioContext.state === 'suspended') {
      await audioContext.resume()
    }

    pushTheoreticalStep(startTime)

    cueTimer = setInterval(() => {
      pushTheoreticalStep(Date.now())
    }, intervalMs)

    liveTimer = setInterval(() => {
      updateLiveData()
    }, 100)
  }

  startAudio()

  startGpsWatch()

  startSessionBtn.disabled = true
  stopSessionBtn.disabled = false
  exportCsvBtn.disabled = true
  updateStatusBox()
}

function stopSession() {
  sessionRunning = false

  if (cueTimer) {
    clearInterval(cueTimer)
    cueTimer = null
  }

  if (liveTimer) {
    clearInterval(liveTimer)
    liveTimer = null
  }

  stopGpsWatch()

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
    Peak threshold: <strong>${peakThreshold.toFixed(2)}</strong><br>
    Refractory window: <strong>${refractoryMs} ms</strong>
  `

  maybeEnableStart()
})

enableMotionBtn.addEventListener('click', enableMotion)
enableGpsBtn.addEventListener('click', enableGps)
startSessionBtn.addEventListener('click', startSession)
stopSessionBtn.addEventListener('click', stopSession)
exportCsvBtn.addEventListener('click', exportCsv)

updateStatusBox()
updateLiveData()