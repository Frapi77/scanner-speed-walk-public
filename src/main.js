import './style.css'

document.querySelector('#app').innerHTML = `
  <main class="container">
    <h1>Scanner Speed Walk</h1>
    <p class="subtitle">Performative walk at 882 m/h</p>

    <section class="card">
      <label for="stepLength">Step length (cm)</label>
      <input id="stepLength" type="number" min="1" step="0.1" placeholder="e.g. 70" />

      <button id="calculateBtn">Calculate interval</button>
      <button id="startCueBtn" disabled>Start cue</button>
      <button id="stopCueBtn" disabled>Stop cue</button>

      <div id="result" class="result">
        Insert your step length and calculate the interval.
      </div>

      <div id="liveData" class="result">
        Elapsed time: <strong>0.0 s</strong><br>
        Theoretical steps: <strong>0</strong>
      </div>
    </section>
  </main>
`

const SCANNER_SPEED_M_PER_HOUR = 882
const SCANNER_SPEED_M_PER_SECOND = SCANNER_SPEED_M_PER_HOUR / 3600

const stepLengthInput = document.querySelector('#stepLength')
const calculateBtn = document.querySelector('#calculateBtn')
const startCueBtn = document.querySelector('#startCueBtn')
const stopCueBtn = document.querySelector('#stopCueBtn')
const result = document.querySelector('#result')
const liveData = document.querySelector('#liveData')

let intervalSeconds = null
let cueTimer = null
let liveTimer = null
let audioContext = null
let startTime = null
let theoreticalStepCount = 0

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

function updateLiveData() {
  if (!startTime) {
    liveData.innerHTML = `
      Elapsed time: <strong>0.0 s</strong><br>
      Theoretical steps: <strong>0</strong>
    `
    return
  }

  const elapsedSeconds = (Date.now() - startTime) / 1000

  liveData.innerHTML = `
    Elapsed time: <strong>${elapsedSeconds.toFixed(1)} s</strong><br>
    Theoretical steps: <strong>${theoreticalStepCount}</strong>
  `
}

calculateBtn.addEventListener('click', () => {
  const stepLengthCm = Number(stepLengthInput.value)

  if (!stepLengthCm || stepLengthCm <= 0) {
    result.textContent = 'Please enter a valid step length in centimeters.'
    startCueBtn.disabled = true
    stopCueBtn.disabled = true
    return
  }

  const stepLengthM = stepLengthCm / 100
  intervalSeconds = stepLengthM / SCANNER_SPEED_M_PER_SECOND
  const stepsPerMinute = 60 / intervalSeconds

  result.innerHTML = `
    Scanner speed: <strong>882 m/h</strong><br>
    Step length: <strong>${stepLengthCm.toFixed(1)} cm</strong><br>
    Step interval: <strong>${intervalSeconds.toFixed(2)} s</strong><br>
    Steps per minute: <strong>${stepsPerMinute.toFixed(2)}</strong>
  `

  startCueBtn.disabled = false
})

startCueBtn.addEventListener('click', async () => {
  if (!intervalSeconds) return

  if (!audioContext) {
    audioContext = new window.AudioContext()
  }

  if (audioContext.state === 'suspended') {
    await audioContext.resume()
  }

  if (cueTimer) clearInterval(cueTimer)
  if (liveTimer) clearInterval(liveTimer)

  startTime = Date.now()
  theoreticalStepCount = 0
  updateLiveData()

  playBeep()
  theoreticalStepCount += 1
  updateLiveData()

  cueTimer = setInterval(() => {
    playBeep()
    theoreticalStepCount += 1
    updateLiveData()
  }, intervalSeconds * 1000)

  liveTimer = setInterval(() => {
    updateLiveData()
  }, 100)

  startCueBtn.disabled = true
  stopCueBtn.disabled = false
})

stopCueBtn.addEventListener('click', () => {
  if (cueTimer) {
    clearInterval(cueTimer)
    cueTimer = null
  }

  if (liveTimer) {
    clearInterval(liveTimer)
    liveTimer = null
  }

  startCueBtn.disabled = false
  stopCueBtn.disabled = true
})