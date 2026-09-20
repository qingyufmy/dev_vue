import { ref } from 'vue'
import { createApiClient } from '@aurum/api-client'
import type { PersonalSettings, PersonalInbox } from '@aurum/contracts'
export const personalClient = createApiClient()
export const personalSettings = ref<PersonalSettings | null>(null)
export const personalInbox = ref<PersonalInbox>({items:[],unread:0})
export const soundReady = ref(false)
let audio: AudioContext | null = null
export async function playNotice(sound: string) {
  if (sound === 'off') return
  audio ??= new AudioContext()
  await audio.resume()
  soundReady.value = audio.state === 'running'
  const notes = sound === 'bell' ? [880,660] : sound === 'pulse' ? [440,440] : [523,659,784]
  notes.forEach((note,index) => {
    const oscillator = audio!.createOscillator(), gain = audio!.createGain(), start = audio!.currentTime + index * 0.15
    oscillator.type = 'sine'; oscillator.frequency.value = note
    gain.gain.setValueAtTime(0,start); gain.gain.linearRampToValueAtTime(0.12,start+0.02); gain.gain.exponentialRampToValueAtTime(0.001,start+0.25)
    oscillator.connect(gain);gain.connect(audio!.destination);oscillator.start(start);oscillator.stop(start+0.3)
  })
}
