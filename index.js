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

// ==================== MESSAGE EXTRACTION ====================
function extractMessageContent(message) {
    try {
        let messageText = ''
        let messageType = 'unknown'
        let additionalInfo = {}

        // Handle different message types
        if (message.conversation) {
            messageText = message.conversation
            messageType = 'text'
        } else if (message.extendedTextMessage) {
            messageText = message.extendedTextMessage.text || ''
            messageType = 'extended_text'
            
            // Handle quoted messages
            if (message.extendedTextMessage.contextInfo?.quotedMessage) {
                const quotedText = extractMessageContent(message.extendedTextMessage.contextInfo.quotedMessage).text
                additionalInfo.quotedMessage = quotedText
            }
            
            // Handle mentions
            if (message.extendedTextMessage.contextInfo?.mentionedJid?.length > 0) {
                additionalInfo.mentions = message.extendedTextMessage.contextInfo.mentionedJid
            }
        } else if (message.imageMessage) {
            messageText = message.imageMessage.caption || '[Image]'
            messageType = 'image'
            additionalInfo.mimeType = message.imageMessage.mimetype
        } else if (message.videoMessage) {
            messageText = message.videoMessage.caption || '[Video]'
            messageType = 'video'
            additionalInfo.mimeType = message.videoMessage.mimetype
        } else if (message.audioMessage) {
            messageText = '[Audio Message]'
            messageType = 'audio'
            additionalInfo.duration = message.audioMessage.seconds
            additionalInfo.mimeType = message.audioMessage.mimetype
        } else if (message.documentMessage) {
            messageText = `[Document: ${message.documentMessage.fileName || 'Unknown'}]`
            messageType = 'document'
            additionalInfo.fileName = message.documentMessage.fileName
            additionalInfo.mimeType = message.documentMessage.mimetype
        } else if (message.stickerMessage) {
            messageText = '[Sticker]'
            messageType = 'sticker'
        } else if (message.locationMessage) {
            const lat = message.locationMessage.degreesLatitude
            const lng = message.locationMessage.degreesLongitude
            messageText = `[Location: ${lat}, ${lng}]`
            messageType = 'location'
            additionalInfo.coordinates = { latitude: lat, longitude: lng }
        } else if (message.contactMessage) {
            const contact = message.contactMessage
            messageText = `[Contact: ${contact.displayName || 'Unknown'}]`
            messageType = 'contact'
            additionalInfo.vcard = contact.vcard
        } else if (message.contactsArrayMessage) {
            const contacts = message.contactsArrayMessage.contacts
            messageText = `[Contacts: ${contacts.length} contact(s)]`
            messageType = 'contacts_array'
            additionalInfo.contactCount = contacts.length
        } else if (message.liveLocationMessage) {
            const lat = message.liveLocationMessage.degreesLatitude
            const lng = message.liveLocationMessage.degreesLongitude
            messageText = `[Live Location: ${lat}, ${lng}]`
            messageType = 'live_location'
            additionalInfo.coordinates = { latitude: lat, longitude: lng }
        } else if (message.buttonsMessage) {
            messageText = message.buttonsMessage.contentText || '[Interactive Buttons Message]'
            messageType = 'buttons'
            additionalInfo.buttons = message.buttonsMessage.buttons
        } else if (message.listMessage) {
            messageText = message.listMessage.description || '[List Message]'
            messageType = 'list'
            additionalInfo.title = message.listMessage.title
        } else if (message.templateMessage) {
            // Handle template messages (buttons, lists, etc.)
            if (message.templateMessage.hydratedTemplate) {
                messageText = message.templateMessage.hydratedTemplate.hydratedContentText || '[Template Message]'
            } else {
                messageText = '[Template Message]'
            }
            messageType = 'template'
        } else if (message.reactionMessage) {
            messageText = `[Reaction: ${message.reactionMessage.text}]`
            messageType = 'reaction'
            additionalInfo.reactionEmoji = message.reactionMessage.text
        } else {
            // Try to find any text in unknown message types
            const messageKeys = Object.keys(message)
            for (const key of messageKeys) {
                if (message[key] && typeof message[key] === 'object') {
                    if (message[key].text) {
                        messageText = message[key].text
                        messageType = key
                        break
                    } else if (message[key].caption) {
                        messageText = message[key].caption
                        messageType = key
                        break
                    }
                }
            }
            
            if (!messageText) {
                messageText = '[Unsupported Message Type]'
                messageType = 'unsupported'
                additionalInfo.messageKeys = messageKeys
            }
        }

        // Clean up and normalize the text
        if (messageText) {
            // Preserve original formatting but ensure it's properly encoded
            messageText = messageText.toString()
            
            // Handle special characters and emojis properly
            messageText = Buffer.from(messageText, 'utf8').toString('utf8')
        }

        return {
            text: messageText,
            type: messageType,
            additionalInfo: additionalInfo
        }
    } catch (error) {
        console.log('❌ Error extracting message content:', error)
        return {
            text: '[Error processing message]',
            type: 'error',
            additionalInfo: { error: error.message }
        }
    }
}

// Enhanced function to detect and extract links
function extractLinks(text) {
    const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+|[^\s]+\.[^\s]{2,}\/[^\s]*)/gi
    const links = text.match(urlRegex) || []
    return links.map(link => {
        // Ensure proper protocol
        if (!link.startsWith('http://') && !link.startsWith('https://')) {
            return `https://${link}`
        }
        return link
    })
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

// Enhanced Create Note in HubSpot
async function createNote(contactId, messageContent, phoneNumber, isOutgoing = false) {
    if (!contactId) {
        console.log(`❌ Contact not found for ${phoneNumber}, skipping note.`)
        return
    }
    
    try {
        console.log(`📝 Creating note for contact ${contactId}...`)
        const direction = isOutgoing ? "WhatsApp message sent" : "WhatsApp message received"
        
        // Build comprehensive note body
        let noteBody = `${direction}\nPhone: ${phoneNumber}\nMessage Type: ${messageContent.type}\n\n`
        
        // Add the main message text
        noteBody += `Message: ${messageContent.text}\n`
        
        // Add additional information if available
        if (Object.keys(messageContent.additionalInfo).length > 0) {
            noteBody += '\nAdditional Information:\n'
            
            if (messageContent.additionalInfo.quotedMessage) {
                noteBody += `• Replying to: "${messageContent.additionalInfo.quotedMessage}"\n`
            }
            
            if (messageContent.additionalInfo.mentions) {
                noteBody += `• Mentions: ${messageContent.additionalInfo.mentions.join(', ')}\n`
            }
            
            if (messageContent.additionalInfo.coordinates) {
                const { latitude, longitude } = messageContent.additionalInfo.coordinates
                noteBody += `• Location: ${latitude}, ${longitude}\n`
            }
            
            if (messageContent.additionalInfo.fileName) {
                noteBody += `• File: ${messageContent.additionalInfo.fileName}\n`
            }
            
            if (messageContent.additionalInfo.mimeType) {
                noteBody += `• File Type: ${messageContent.additionalInfo.mimeType}\n`
            }
            
            if (messageContent.additionalInfo.duration) {
                noteBody += `• Duration: ${messageContent.additionalInfo.duration} seconds\n`
            }
            
            if (messageContent.additionalInfo.reactionEmoji) {
                noteBody += `• Reaction: ${messageContent.additionalInfo.reactionEmoji}\n`
            }
        }
        
        // Extract and add links if present
        const links = extractLinks(messageContent.text)
        if (links.length > 0) {
            noteBody += `\nLinks found:\n${links.map(link => `• ${link}`).join('\n')}\n`
        }
        
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
            console.log(`📝 Message Type: ${messageContent.type}`)
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
        defaultQueryTimeoutMs: 60000,
    })
    return { sock, saveCreds }
}

async function startWhatsApp() {
    const { sock: newSock, saveCreds } = await connectToWhatsApp()
    sock = newSock

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        
        if (qr) {
            console.log('📲 Scan this QR code:')
            qrcode.generate(qr, { small: true })
        }
        
        if (connection === 'open') {
            console.log('✅ WhatsApp connected!')
            console.log('🎯 Listening for messages...')
        }
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
            console.log('❌ Connection closed due to', lastDisconnect?.error, ', reconnecting:', shouldReconnect)
            
            if (shouldReconnect) {
                setTimeout(() => startWhatsApp(), 3000)
            }
        }
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return
        
        for (const msg of messages) {
            try {
                if (!msg.message) continue
                
                // Get phone number (remove @s.whatsapp.net or @g.us)
                const otherPartyNumber = msg.key.remoteJid?.split('@')[0]
                
                // Skip group messages for now (they end with @g.us)
                if (msg.key.remoteJid?.endsWith('@g.us')) {
                    console.log(`📱 Skipping group message from ${otherPartyNumber}`)
                    continue
                }
                
                // Extract comprehensive message content
                const messageContent = extractMessageContent(msg.message)
                
                console.log(`📨 Message received from ${otherPartyNumber}:`)
                console.log(`   Type: ${messageContent.type}`)
                console.log(`   Content: ${messageContent.text}`)
                
                if (Object.keys(messageContent.additionalInfo).length > 0) {
                    console.log(`   Additional Info:`, messageContent.additionalInfo)
                }
                
                // Find contact and create note
                const contactId = await findContactByPhone(otherPartyNumber)
                await createNote(contactId, messageContent, otherPartyNumber, msg.key.fromMe)
                
            } catch (error) {
                console.log('❌ Error processing message:', error)
            }
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
