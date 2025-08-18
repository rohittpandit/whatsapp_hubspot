import baileys, { DisconnectReason } from '@whiskeysockets/baileys'
import express from 'express'
import fetch from 'node-fetch'
import open from 'open'
import { makeWASocket, useMultiFileAuthState } from '@whiskeysockets/baileys'
import fs from 'fs'
import qrcode from 'qrcode-terminal'

// ==================== CONFIG ====================
const CLIENT_ID = 'b6827f04-e977-4160-b2c9-e39ede81454d'
const CLIENT_SECRET = '36975951-efff-48d7-99c8-e0af3afea8c6'
const REDIRECT_URI = 'http://localhost:3000/oauth-callback'
const PORT = 3000
const TOKEN_FILE = './hubspot_token.json'
// =================================================

let ACCESS_TOKEN = null
let sock = null
const app = express()

// Function to reset HubSpot connection
function resetHubSpotConnection() {
    if (fs.existsSync(TOKEN_FILE)) {
        fs.unlinkSync(TOKEN_FILE)
        console.log('✅ HubSpot token file deleted')
    }
    ACCESS_TOKEN = null
    console.log('🔄 HubSpot connection reset. Restart the app to reconnect.')
}

// ==================== REFRESH TOKEN HANDLER ====================
async function refreshHubSpotToken() {
    try {
        if (!fs.existsSync(TOKEN_FILE)) {
            console.log("❌ No token file found. Please reconnect via /reset")
            return null
        }

        const tokenData = JSON.parse(fs.readFileSync(TOKEN_FILE))

        if (!tokenData.refresh_token) {
            console.log("❌ No refresh token available. Please reconnect via /reset")
            return null
        }

        const res = await fetch("https://api.hubapi.com/oauth/v1/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                redirect_uri: REDIRECT_URI,
                refresh_token: tokenData.refresh_token
            })
        })

        const data = await res.json()
        if (data.access_token) {
            console.log("🔄 Refreshed HubSpot token")
            ACCESS_TOKEN = data.access_token
            fs.writeFileSync(TOKEN_FILE, JSON.stringify({ ...tokenData, ...data }, null, 2))
            return ACCESS_TOKEN
        } else {
            console.log("❌ Failed to refresh token:", data)
            return null
        }
    } catch (err) {
        console.log("❌ Error refreshing token:", err)
        return null
    }
}

// ==================== OAUTH FLOW ====================
app.get('/', async (req, res) => {
    const authUrl = `https://app.hubspot.com/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=crm.objects.contacts.read%20crm.objects.contacts.write%20crm.objects.custom.write%20crm.schemas.contacts.read`
    await open(authUrl)
    res.send('Opening HubSpot authorization in your browser...')
})

app.get('/reset', (req, res) => {
    resetHubSpotConnection()
    res.send('HubSpot connection reset! Restart the app to reconnect.')
})

app.get('/oauth-callback', async (req, res) => {
    const code = req.query.code
    if (!code) return res.status(400).send('No code provided')

    const tokenRes = await fetch('https://api.hubapi.com/oauth/v1/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            redirect_uri: REDIRECT_URI,
            code
        })
    })

    const data = await tokenRes.json()
    if (data.access_token) {
        ACCESS_TOKEN = data.access_token
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2))
        console.log('✅ HubSpot Access + Refresh Token saved.')
        res.send('Authorization successful! WhatsApp listener starting...')
        startWhatsApp()
    } else {
        res.send('❌ Failed to get access token: ' + JSON.stringify(data))
    }
})

// ==================== HUBSPOT HELPERS ====================
async function hubspotFetch(url, options, retry = true) {
    const res = await fetch(url, options)
    if (res.status === 401 && retry) {
        console.log("⚠️ Token expired, refreshing...")
        const newToken = await refreshHubSpotToken()
        if (newToken) {
            options.headers.Authorization = `Bearer ${newToken}`
            return hubspotFetch(url, options, false)
        }
    }
    return res
}

// Find contact by phone
async function findContactByPhone(phone) {
    try {
        const cleanPhone = phone.replace(/[\s\-\+\(\)]/g, '')
        const phoneFormats = [
            phone, cleanPhone, `+${cleanPhone}`,
            cleanPhone.replace(/^91/, '+91'),
            cleanPhone.substring(2),
            `+91${cleanPhone.substring(2)}`
        ]
        const uniqueFormats = [...new Set(phoneFormats)]
        console.log(`🔍 Searching for contact with phone formats:`, uniqueFormats)

        for (const phoneFormat of uniqueFormats) {
            const res = await hubspotFetch(`https://api.hubapi.com/crm/v3/objects/contacts/search`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    filterGroups: [{
                        filters: [{ propertyName: 'phone', operator: 'EQ', value: phoneFormat }]
                    }],
                    properties: ['firstname', 'lastname', 'phone', 'mobilephone']
                })
            })

            const data = await res.json()
            console.log(`📞 Searching with format "${phoneFormat}":`, data.results?.length || 0, 'results found')

            if (data.results?.length > 0) {
                console.log(`✅ Found contact:`, data.results[0])
                return data.results[0].id
            }
        }

        console.log(`❌ No contact found for phone: ${phone}`)
        return null
    } catch (error) {
        console.log('❌ Error finding contact:', error)
        return null
    }
}

// Create Note in HubSpot
async function createNote(contactId, message, phoneNumber, isOutgoing = false) {
    if (!contactId) {
        console.log(`❌ Contact not found for ${phoneNumber}, skipping note.`)
        return
    }
    try {
        console.log(`📝 Creating note for contact ${contactId}...`)
        const direction = isOutgoing ? "WhatsApp message sent" : "WhatsApp message received"
        const noteBody = `${direction}\nPhone: ${phoneNumber}\n\n${message}`

        const res = await hubspotFetch(`https://api.hubapi.com/crm/v3/objects/notes`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                properties: {
                    hs_note_body: noteBody,
                    hs_timestamp: new Date().toISOString()
                },
                associations: [
                    {
                        to: { id: contactId },
                        types: [
                            {
                                associationCategory: 'HUBSPOT_DEFINED',
                                associationTypeId: 202
                            }
                        ]
                    }
                ]
            })
        })

        const responseData = await res.json()
        if (res.ok) {
            console.log(`✅ Note added successfully to contact ${contactId}`)
            console.log(`📄 Note ID: ${responseData.id}`)
        } else {
            console.log(`❌ Failed to add note:`, responseData)
        }
    } catch (error) {
        console.log('❌ Error creating note:', error)
    }
}

// Test HubSpot Connection
async function testHubSpotConnection() {
    try {
        console.log('🧪 Testing HubSpot connection...')
        const res = await hubspotFetch(`https://api.hubapi.com/crm/v3/objects/contacts?limit=10&properties=firstname,lastname,phone,mobilephone`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        })
        const data = await res.json()
        if (res.ok) {
            console.log('✅ HubSpot connection successful!')
            console.log(`📊 Found ${data.results.length} contacts`)
        } else {
            console.log('❌ HubSpot connection failed:', data)
        }
    } catch (error) {
        console.log('❌ Error testing HubSpot:', error)
    }
}

// ==================== WHATSAPP ====================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info')
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ["WhatsApp-HubSpot Bot", "Desktop", "1.0.0"],
    })
    return { sock, saveCreds }
}

async function startWhatsApp() {
    const { sock: newSock, saveCreds } = await connectToWhatsApp()
    sock = newSock

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr } = update
        if (qr) {
            console.log('📲 Scan this QR code:')
            qrcode.generate(qr, { small: true })
        }
        if (connection === 'open') console.log('✅ WhatsApp connected!')
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (!msg.message) continue
            const otherPartyNumber = msg.key.remoteJid?.split('@')[0]
            const textMessage = msg.message.conversation || 'Media message'
            const contactId = await findContactByPhone(otherPartyNumber)
            await createNote(contactId, textMessage, otherPartyNumber, msg.key.fromMe)
        }
    })
}

// ==================== APP START ====================
if (fs.existsSync(TOKEN_FILE)) {
    const tokenData = JSON.parse(fs.readFileSync(TOKEN_FILE))
    ACCESS_TOKEN = tokenData.access_token
    console.log('✅ Using saved HubSpot token.')
    console.log('💡 To reset HubSpot connection, visit: http://localhost:3000/reset')
    await testHubSpotConnection()
    startWhatsApp()
} else {
    console.log('🔄 No HubSpot token found. Starting OAuth flow...')
    app.listen(PORT, () => {
        console.log(`🚀 Server running at http://localhost:${PORT}`)
        console.log('➡ Visit this URL to start OAuth: http://localhost:3000')
    })
}
