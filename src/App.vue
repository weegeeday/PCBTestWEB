<script setup>
import { ref, onMounted, nextTick } from 'vue'
import { ESPLoader, Transport } from 'esptool-js'

const port = ref(null)
const reader = ref(null)
const writer = ref(null)
const isConnected = ref(false)
const terminalLines = ref([])
const inputText = ref('')
const terminalContainer = ref(null)
let readStreamClosed = null

const activePopup = ref(null)
const tempInput = ref('')
const rawBuffer = ref('')

// Flashing States
const isFlashing = ref(false)
const flashStatus = ref('')
const flashProgress = ref(0)
const flashError = ref(null)

const connect = async () => {
  try {
    const p = port.value || await navigator.serial.requestPort()
    await p.open({ baudRate: 115200 })
    port.value = p
    isConnected.value = true

    const textEncoder = new TextEncoderStream()
    textEncoder.readable.pipeTo(p.writable)
    writer.value = textEncoder.writable.getWriter()

    const textDecoder = new TextDecoderStream()
    readStreamClosed = p.readable.pipeTo(textDecoder.writable)
    reader.value = textDecoder.readable.getReader()

    terminalLines.value.push({ text: 'Connected to ESP32 Test Board...', type: 'system' })
    readLoop()
  } catch (err) {
    console.error('Connection error:', err)
    terminalLines.value.push({ text: `Connection failed: ${err.message}`, type: 'error' })
  }
}

const disconnect = async () => {
  isConnected.value = false
  try {
    if (reader.value) {
      await reader.value.cancel()
      reader.value = null
    }
    if (readStreamClosed) {
      await readStreamClosed.catch(() => {})
    }
    if (writer.value) {
      await writer.value.close()
      writer.value = null
    }
    if (port.value) {
      await port.value.close()
    }
    terminalLines.value.push({ text: 'Disconnected.', type: 'system' })
  } catch (err) {
    console.error('Disconnect error:', err)
  }
}

const checkPrompts = (text) => {
  if (text.includes('Press any key (and hit Enter) to start testing')) {
    activePopup.value = 'start'
  } else if (text.includes('Enter Wi-Fi SSID:')) {
    activePopup.value = 'wifi-ssid'
  } else if (text.includes('Enter Wi-Fi Password:')) {
    activePopup.value = 'wifi-pass'
  } else if (text.includes('Please connect a motor to header P3')) {
    activePopup.value = 'motor-ready'
  } else if (text.includes('Did the motor spin? (y/n)')) {
    activePopup.value = 'motor-confirm'
  } else if (text.includes('Please connect a servo to header P5')) {
    activePopup.value = 'servo-ready'
  } else if (text.includes('Did the servo turn? (y/n)')) {
    activePopup.value = 'servo-confirm'
  } else if (text.includes('TESTING COMPLETE')) {
    activePopup.value = 'complete'
  }
}

const readLoop = async () => {
  try {
    while (true) {
      const { value, done } = await reader.value.read()
      if (done) {
        reader.value.releaseLock()
        break
      }
      if (value) {
        appendToTerminal(value, 'rx')
        
        // Add to raw buffer for popup matching
        rawBuffer.value += value
        // Keep buffer size reasonable
        if (rawBuffer.value.length > 500) {
          rawBuffer.value = rawBuffer.value.slice(-500)
        }
        
        // Check if we need to show a popup
        if (!activePopup.value) {
          checkPrompts(rawBuffer.value)
        }
      }
    }
  } catch (err) {
    console.error('Read error:', err)
    isConnected.value = false
  }
}

const appendToTerminal = (text, type) => {
  if (type === 'rx' && terminalLines.value.length > 0) {
    const lastLine = terminalLines.value[terminalLines.value.length - 1]
    if (lastLine.type === 'rx') {
      lastLine.text += text
      scrollToBottom()
      return
    }
  }
  terminalLines.value.push({ text, type })
  scrollToBottom()
}

const scrollToBottom = async () => {
  await nextTick()
  if (terminalContainer.value) {
    terminalContainer.value.scrollTop = terminalContainer.value.scrollHeight
  }
}

const sendResponse = async (msg) => {
  activePopup.value = null
  rawBuffer.value = '' // Clear so we don't re-trigger immediately
  
  if (!isConnected.value || !writer.value) return
  
  try {
    await writer.value.write(msg + '\n')
    appendToTerminal(msg + '\n', 'tx')
  } catch (err) {
    console.error('Write error:', err)
    terminalLines.value.push({ text: `Write failed: ${err.message}`, type: 'error' })
  }
}

const send = async () => {
  if (!inputText.value) return
  const cmd = inputText.value
  inputText.value = ''
  await sendResponse(cmd)
}

// esptool-js Terminal Logger Interface
const espTerminal = {
  clean: () => {
    terminalLines.value = []
  },
  writeLine: (data) => {
    appendToTerminal(data + '\n', 'system')
  },
  write: (data) => {
    appendToTerminal(data, 'system')
  }
}

// Flashing sequence
const flashLatestFirmware = async () => {
  isFlashing.value = true
  flashError.value = null
  flashProgress.value = 0
  flashStatus.value = 'Resolving latest release...'
  
  try {
    // 1. Fetch latest release details directly from the Git server
    const res = await fetch('https://git.weegeeday.com/api/v1/repos/weegeeday/RCCar/releases')
    if (!res.ok) throw new Error(`Failed to check releases: ${res.statusText}`)
    
    // Validate response is JSON before parsing
    const contentType = res.headers.get('content-type')
    if (!contentType?.includes('application/json')) {
      throw new Error(`Expected JSON response, got ${contentType || 'unknown type'}`)
    }
    
    const releases = await res.json()
    const newestRelease = releases[0]
    if (!newestRelease) throw new Error('No releases found in the repository.')
    
    // Find the firm.bin asset
    const asset = newestRelease.assets.find(a => a.name === 'firm.bin')
    if (!asset) throw new Error(`No firm.bin found in release ${newestRelease.name}`)
    
    // Use the direct asset URL
    const proxyDownloadUrl = asset.browser_download_url
    
    // 2. Download firmware
    flashStatus.value = `Downloading firm.bin (version ${newestRelease.name})...`
    const binRes = await fetch(proxyDownloadUrl)
    if (!binRes.ok) throw new Error(`Failed to download firmware: ${binRes.statusText}`)
    const firmwareBuffer = await binRes.arrayBuffer()
    
    // 3. Disconnect active terminal monitor
    if (isConnected.value) {
      flashStatus.value = 'Disconnecting terminal monitor...'
      await disconnect()
    }
    
    // 4. Request port if not yet selected
    if (!port.value) {
      flashStatus.value = 'Please select your ESP32 serial port...'
      port.value = await navigator.serial.requestPort()
    }
    
    flashStatus.value = 'Initializing flasher...'
    appendToTerminal('Starting flash process...\n', 'system')
    
    // 5. Connect and flash using esptool-js
    const transport = new Transport(port.value)
    const esploader = new ESPLoader({
      transport: transport,
      baudrate: 115200,
      terminal: espTerminal
    })
    
    flashStatus.value = 'Connecting to bootloader...'
    const chip = await esploader.main()
    appendToTerminal(`Connected to chip: ${chip}\n`, 'system')
    
    flashStatus.value = 'Uploading firmware...'
    const flashOptions = {
      fileArray: [
        {
          data: new Uint8Array(firmwareBuffer),
          address: 0x0 // Flashed at 0x0 as a merged binary (containing bootloader, partitions, and app)
        }
      ],
      flashMode: 'dio',
      flashFreq: '40m',
      flashSize: '4MB',
      eraseAll: true,
      compress: true,
      reportProgress: (fileIndex, written, total) => {
        flashProgress.value = Math.round((written / total) * 100)
        flashStatus.value = `Uploading firmware... ${flashProgress.value}%`
      }
    }
    
    await esploader.writeFlash(flashOptions)
    
    flashStatus.value = 'Rebooting device...'
    appendToTerminal('Hard resetting chip...\n', 'system')
    await esploader.after('hard_reset')
    
    try {
      await transport.disconnect()
    } catch (e) {
      console.warn('Transport disconnect warning:', e)
    }
    
    flashStatus.value = 'Flashing complete!'
    
    // Briefly show complete status then close modal and auto-reconnect
    setTimeout(async () => {
      isFlashing.value = false
      appendToTerminal('Firmware successfully flashed. Reconnecting serial tester...\n', 'system')
      try {
        await connect()
      } catch (err) {
        console.error('Auto-reconnect error:', err)
        appendToTerminal('Could not auto-reconnect. Please click Connect Device manually.\n', 'error')
      }
    }, 1500)
    
  } catch (err) {
    console.error('Flash error:', err)
    flashError.value = err.message || err
    flashStatus.value = 'Flashing failed'
    appendToTerminal(`[FLASH ERROR] ${err.message || err}\n`, 'error')
  }
}
</script>

<template>
  <div class="app-container">
    <header class="top-bar">
      <div class="brand">
        <div class="status-dot" :class="{ active: isConnected }"></div>
        <h1>ESP32 Production Tester</h1>
      </div>
      <div class="actions-group">
        <button @click="flashLatestFirmware" :disabled="isFlashing" class="btn-flash">
          {{ isFlashing ? 'Flashing...' : 'Flash Latest Firmware' }}
        </button>
        <button v-if="!isConnected" @click="connect" class="btn-connect" :disabled="isFlashing">
          Connect Device
        </button>
        <button v-else @click="disconnect" class="btn-disconnect" :disabled="isFlashing">
          Disconnect
        </button>
      </div>
    </header>

    <main class="terminal-wrapper">
      <div class="terminal-body" ref="terminalContainer">
        <div v-if="terminalLines.length === 0" class="empty-state">
          No data yet. Click 'Connect Device' and select the ESP32 serial port.
        </div>
        <div 
          v-for="(line, index) in terminalLines" 
          :key="index"
          class="log-entry"
          :class="`log-${line.type}`"
        >
          <span v-if="line.type === 'tx'" class="prompt-icon">❯</span>
          <span class="log-text">{{ line.text }}</span>
        </div>
      </div>
      
      <div class="input-area" :class="{ disabled: !isConnected }">
        <span class="input-prefix">❯</span>
        <input 
          v-model="inputText" 
          @keyup.enter="send"
          type="text" 
          placeholder="Type your command or response here..."
          :disabled="!isConnected"
          autocomplete="off"
        />
        <button @click="send" :disabled="!isConnected || !inputText" class="btn-send">
          Send
        </button>
      </div>
    </main>

    <!-- Modal Overlay -->
    <div v-if="activePopup" class="modal-overlay">
      <div class="modal">
        <template v-if="activePopup === 'start'">
          <h2>Ready to Test</h2>
          <p>The ESP32 is waiting to start the test sequence.</p>
          <button class="btn-primary btn-large" @click="sendResponse('')">Start Testing</button>
        </template>
        
        <template v-else-if="activePopup === 'wifi-ssid'">
          <h2>Wi-Fi Setup</h2>
          <p>Enter the Wi-Fi SSID for the network test:</p>
          <input class="modal-input" v-model="tempInput" type="text" placeholder="SSID" @keyup.enter="sendResponse(tempInput); tempInput=''" />
          <button class="btn-primary" @click="sendResponse(tempInput); tempInput=''">Submit</button>
        </template>
        
        <template v-else-if="activePopup === 'wifi-pass'">
          <h2>Wi-Fi Setup</h2>
          <p>Enter the Wi-Fi Password:</p>
          <input class="modal-input" v-model="tempInput" type="password" placeholder="Password" @keyup.enter="sendResponse(tempInput); tempInput=''" />
          <button class="btn-primary" @click="sendResponse(tempInput); tempInput=''">Submit</button>
        </template>
        
        <template v-else-if="activePopup === 'motor-ready'">
          <h2>Motor Test (Header P3)</h2>
          <p>Please connect a motor to header <strong>P3</strong>.</p>
          <div class="modal-image-container">
            <!-- Expected motor.png to exist in public/images/ -->
            <img src="/images/motor.png" alt="Connect Motor to P3" class="modal-img" onerror="this.style.display='none'" />
          </div>
          <button class="btn-primary btn-large" @click="sendResponse('')">I'm Ready (Spin Motor)</button>
        </template>
        
        <template v-else-if="activePopup === 'motor-confirm'">
          <h2>Motor Test Result</h2>
          <p>Did the motor spin for 3 seconds?</p>
          <div class="btn-group">
            <button class="btn-success btn-large" @click="sendResponse('y')">Yes (PASS)</button>
            <button class="btn-danger btn-large" @click="sendResponse('n')">No (FAIL)</button>
          </div>
        </template>

        <template v-else-if="activePopup === 'servo-ready'">
          <h2>Servo Test (Header P5)</h2>
          <p>Please connect a servo to header <strong>P5</strong> (IO38).</p>
          <div class="modal-image-container">
            <!-- Expected servo.png to exist in public/images/ -->
            <img src="/images/servo.png" alt="Connect Servo to P5" class="modal-img" onerror="this.style.display='none'" />
          </div>
          <button class="btn-primary btn-large" @click="sendResponse('')">I'm Ready (Sweep Servo)</button>
        </template>
        
        <template v-else-if="activePopup === 'servo-confirm'">
          <h2>Servo Test Result</h2>
          <p>Did the servo turn correctly?</p>
          <div class="btn-group">
            <button class="btn-success btn-large" @click="sendResponse('y')">Yes (PASS)</button>
            <button class="btn-danger btn-large" @click="sendResponse('n')">No (FAIL)</button>
          </div>
        </template>

        <template v-else-if="activePopup === 'complete'">
          <h2>Testing Complete!</h2>
          <p>The PCB testing sequence has finished.</p>
          <button class="btn-primary" @click="activePopup = null; rawBuffer = ''">Close</button>
        </template>
      </div>
    </div>

    <!-- Flashing Overlay Modal -->
    <div v-if="isFlashing" class="modal-overlay">
      <div class="modal">
        <h2>Flashing Firmware</h2>
        <p>{{ flashStatus }}</p>
        
        <div v-if="!flashError" class="progress-container">
          <div class="progress-bar-bg">
            <div class="progress-bar-fill" :style="{ width: flashProgress + '%' }"></div>
          </div>
          <span class="progress-percent">{{ flashProgress }}%</span>
        </div>
        
        <div v-if="flashError" class="flash-error-box">
          <p class="error-msg">{{ flashError }}</p>
          <button class="btn-disconnect" @click="isFlashing = false">Dismiss</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  gap: 1.5rem;
  position: relative;
}

.top-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 1.5rem;
  background: var(--panel-bg);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  backdrop-filter: blur(10px);
}

.brand {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.status-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--danger);
  box-shadow: 0 0 10px rgba(239, 68, 68, 0.4);
  transition: all 0.3s ease;
}

.status-dot.active {
  background: var(--success);
  box-shadow: 0 0 10px rgba(16, 185, 129, 0.4);
}

h1 {
  font-size: 1.25rem;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.actions-group {
  display: flex;
  gap: 0.75rem;
}

.btn-connect, .btn-disconnect {
  padding: 0.6rem 1.2rem;
  border-radius: 8px;
  font-weight: 500;
  font-size: 0.9rem;
  color: white;
}

.btn-connect {
  background: var(--accent);
}

.btn-connect:hover {
  background: var(--accent-hover);
  transform: translateY(-1px);
}

.btn-disconnect {
  background: transparent;
  border: 1px solid var(--danger);
  color: var(--danger);
}

.btn-disconnect:hover {
  background: rgba(239, 68, 68, 0.1);
}

.btn-flash {
  padding: 0.6rem 1.2rem;
  border-radius: 8px;
  font-weight: 500;
  font-size: 0.9rem;
  color: white;
  background: linear-gradient(135deg, #a855f7 0%, #7c3aed 100%);
  box-shadow: 0 4px 12px rgba(124, 58, 237, 0.2);
}

.btn-flash:hover:not(:disabled) {
  background: linear-gradient(135deg, #c084fc 0%, #8b5cf6 100%);
  transform: translateY(-1px);
}

.btn-flash:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}

.terminal-wrapper {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: rgba(10, 11, 14, 0.8);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 10px 30px rgba(0,0,0,0.5);
  backdrop-filter: blur(10px);
}

.terminal-body {
  flex: 1;
  padding: 1.5rem;
  overflow-y: auto;
  font-family: 'Fira Code', monospace;
  font-size: 0.95rem;
  line-height: 1.6;
  display: flex;
  flex-direction: column;
}

.terminal-body::-webkit-scrollbar {
  width: 8px;
}
.terminal-body::-webkit-scrollbar-track {
  background: transparent;
}
.terminal-body::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 4px;
}

.empty-state {
  color: var(--text-muted);
  text-align: center;
  margin-top: auto;
  margin-bottom: auto;
  font-family: 'Inter', sans-serif;
}

.log-entry {
  display: flex;
  word-break: break-all;
  white-space: pre-wrap;
}

.log-text {
  flex: 1;
}

.log-rx {
  color: #a7f3d0;
}

.log-tx {
  color: var(--accent-hover);
  margin-top: 0.5rem;
  margin-bottom: 0.5rem;
}

.log-system {
  color: var(--text-muted);
  font-style: italic;
  margin: 0.5rem 0;
}

.log-error {
  color: var(--danger);
  margin: 0.5rem 0;
}

.prompt-icon {
  margin-right: 0.5rem;
  user-select: none;
}

.input-area {
  display: flex;
  align-items: center;
  padding: 1rem 1.5rem;
  background: rgba(255, 255, 255, 0.03);
  border-top: 1px solid var(--border-color);
  gap: 1rem;
}

.input-area.disabled {
  opacity: 0.5;
}

.input-prefix {
  font-family: 'Fira Code', monospace;
  color: var(--accent);
  font-weight: 600;
}

input[type="text"] {
  flex: 1;
  background: transparent;
  border: none;
  color: var(--text-main);
  font-size: 1rem;
  font-family: 'Fira Code', monospace;
}

input[type="text"]::placeholder {
  color: rgba(255, 255, 255, 0.2);
  font-family: 'Inter', sans-serif;
}

.btn-send {
  padding: 0.5rem 1rem;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.1);
  color: white;
  font-weight: 500;
}

.btn-send:not(:disabled):hover {
  background: rgba(255, 255, 255, 0.2);
}

.btn-send:disabled {
  cursor: not-allowed;
}

/* Modal Styles */
.modal-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(8px);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 100;
  border-radius: 12px;
  animation: fadeIn 0.2s ease-out;
}

.modal {
  background: #1e2128;
  border: 1px solid var(--border-color);
  border-radius: 16px;
  padding: 2.5rem;
  width: 90%;
  max-width: 450px;
  text-align: center;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.modal h2 {
  font-size: 1.5rem;
  color: white;
  margin-bottom: 0.5rem;
}

.modal p {
  color: var(--text-muted);
  font-size: 1.05rem;
  line-height: 1.5;
}

.modal-input {
  width: 100%;
  padding: 0.8rem 1rem;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid var(--border-color);
  color: white;
  font-size: 1rem;
  text-align: center;
}

.modal-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
}

.modal-image-container {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 12px;
  padding: 1rem;
  display: flex;
  justify-content: center;
  min-height: 150px;
  align-items: center;
  border: 1px dashed var(--border-color);
}

.modal-img {
  max-width: 100%;
  max-height: 200px;
  border-radius: 8px;
  object-fit: contain;
}

.btn-primary {
  background: var(--accent);
  color: white;
  padding: 0.8rem 1.5rem;
  border-radius: 8px;
  font-weight: 600;
  font-size: 1rem;
  margin-top: 0.5rem;
}

.btn-primary:hover {
  background: var(--accent-hover);
  transform: translateY(-2px);
}

.btn-large {
  padding: 1rem 2rem;
  font-size: 1.1rem;
}

.btn-group {
  display: flex;
  gap: 1rem;
  justify-content: center;
  margin-top: 0.5rem;
}

.btn-success {
  background: var(--success);
  color: white;
  flex: 1;
  border-radius: 8px;
  font-weight: 600;
}

.btn-success:hover {
  background: #059669;
  transform: translateY(-2px);
}

.btn-danger {
  background: var(--danger);
  color: white;
  flex: 1;
  border-radius: 8px;
  font-weight: 600;
}

.btn-danger:hover {
  background: #dc2626;
  transform: translateY(-2px);
}

/* Flashing Progress Bar Styling */
.progress-container {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.progress-bar-bg {
  width: 100%;
  height: 8px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  overflow: hidden;
}

.progress-bar-fill {
  height: 100%;
  background: var(--success);
  border-radius: 4px;
  transition: width 0.2s ease;
}

.progress-percent {
  font-family: 'Fira Code', monospace;
  font-size: 0.9rem;
  color: var(--text-muted);
}

.flash-error-box {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: 100%;
}

.error-msg {
  color: var(--danger) !important;
  font-size: 0.95rem !important;
  word-break: break-word;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(20px) scale(0.95); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
</style>
