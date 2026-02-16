# 🚀 PDX Dark Protocol - Browser Extension Installation Guide

## ⚡ SUPER EASY INSTALL (Like Phantom!)

### **Why Developer Mode? 🤔**
**Because we're loading from files, not Chrome Web Store.** Chrome requires Developer Mode for "unpacked" extensions (local files) to prevent malware. This is security, not a bug!

**Phantom also requires this for local installation!**

**📖 Read the full explanation:** `WHY_DEVELOPER_MODE.txt`

### **Method 1: Drag & Drop (30 seconds)**
```
1. Double-click: DRAG_AND_DROP_INSTALL.bat
2. Enable Developer Mode in Chrome (top right toggle)
3. Drag PDX_Dark.zip onto extensions page
4. Done! 🎉
```

### **Method 2: One-Click Setup**
```
1. Double-click: Setup_PDX_Extension.bat
2. Follow the guided installer
3. Done! 🎉
```

### **Method 3: Manual (if above don't work)**
Follow the visual guide below.

---

## 🎯 Detailed Instructions (3 Minutes)

### For Google Chrome Users:

1. **Download the Extension Files**
   ```
   Go to: pdx_dark_protocol/extension/ folder
   ```

2. **Open Chrome Extensions Page**
   - Type `chrome://extensions/` in address bar
   - OR: Click 3 dots (⋮) → More tools → Extensions

3. **Enable Developer Mode**
   - Click toggle switch: "Developer mode" (top right corner)

4. **Load the Extension**
   - Click "Load unpacked" button
   - Select the `pdx_dark_protocol/extension/` folder
   - Click "Select Folder"

5. **Done! 🎉**
   - PDX extension icon appears in toolbar
   - Click icon to open wallet

### For Microsoft Edge Users:

1. **Download the Extension Files**
   ```
   Go to: pdx_dark_protocol/extension/ folder
   ```

2. **Open Edge Extensions Page**
   - Type `edge://extensions/` in address bar
   - OR: Click 3 dots (⋯) → Extensions → Manage extensions

3. **Enable Developer Mode**
   - Toggle: "Developer mode" (bottom left)

4. **Load the Extension**
   - Click "Load unpacked"
   - Choose the `pdx_dark_protocol/extension/` folder
   - Click "Select Folder"

5. **Done! 🎉**
   - PDX icon shows in toolbar
   - Click to access privacy wallet

---

## 🔧 Troubleshooting

### Extension Not Loading?
- Make sure you selected the correct folder (`pdx_dark_protocol/extension/`)
- Check that all files are present: `manifest.json`, `popup.html`, `popup.js`, etc.

### Extension Icon Not Visible?
- Click the puzzle piece (🧩) icon in toolbar
- Pin the PDX Dark extension
- OR: Click "⋮" → Extensions → PDX Dark → "Show in toolbar"

### Permission Errors?
- The extension needs internet access for Solana devnet
- Allow all requested permissions when prompted

---

## 🎮 How to Use the Extension

### First Time Setup:
1. Click PDX extension icon
2. Click "🔌 Connect Wallet" (Phantom, Solflare, etc.)
3. Approve wallet connection
4. You're ready to send private transfers!

### 💡 How PDX Dark Works:
- **PDX Dark** = Privacy protocol (like a VPN for crypto)
- **Your Wallet** = Where your SOL lives (Phantom, Solflare, etc.)
- **PDX connects to your wallet** to send privacy-protected transfers
- Your funds never leave your wallet - we just add zero-knowledge privacy!

### Generate New Wallet:
1. Click "🎲 Generate New Wallet"
2. Enter wallet name (optional)
3. Wallet downloads automatically
4. Address copies to clipboard

### Send Private Transfer:
1. Click "🕵️ Send Private Transfer"
2. Enter recipient address
3. Enter SOL amount
4. Add memo (optional)
5. Click "Execute Transfer"

### Check Balances:
- SOL balance updates automatically
- $NULL balance shows when connected
- Need 1+ $NULL for privacy transfers

---

## 🔑 What You Can Do

✅ **Connect Phantom Wallet** - Link your existing wallet
✅ **Generate New Wallets** - Create fresh addresses
✅ **Import Private Keys** - Add existing wallets
✅ **Send Private Transfers** - Zero-knowledge transactions
✅ **Claim $NULL Tokens** - Get privacy fee tokens
✅ **Track Balances** - Real-time SOL and $NULL balances

---

## 🚨 Important Safety Notes

⚠️ **This is experimental software**
⚠️ **Only use for testing on devnet**
⚠️ **Never share your private keys**
⚠️ **Backup your wallet files securely**
⚠️ **Disconnect after each session**

---

## 💬 Need Help?

If you get stuck:
1. Check the troubleshooting section above
2. Make sure you're using Chrome or Edge
3. Verify the extension folder path is correct
4. Try refreshing the extensions page

## 🚀 Quick Install (Windows)

**Double-click this file:**
```
pdx_dark_protocol/extension/INSTALL_EXTENSION.bat
```

This opens a visual step-by-step guide in your browser!

## 📱 Mobile Users

Sorry, browser extensions don't work on mobile browsers yet.
Use the full wallet app instead:
```bash
cd pdx_dark_protocol/wallet
npm run dev
```

## 📋 Visual Quick Reference

```
┌─ Step 1: Find Extension Folder ──────────────────────┐
│ 📂 pdx_dark_protocol/extension/                     │
│   ├── manifest.json  ✅                             │
│   ├── popup.html    ✅                              │
│   ├── popup.js      ✅                              │
│   └── install.html  ✅                              │
└─────────────────────────────────────────────────────┘

┌─ Step 2: Open Extensions Page ──────────────────────┐
│ Chrome: chrome://extensions/                        │
│ Edge:   edge://extensions/                          │
│                                                     │
│ Look for: ⋮ → More tools → Extensions              │
└─────────────────────────────────────────────────────┘

┌─ Step 3: Enable Developer Mode ─────────────────────┐
│  ┌─────────────────────────────────┐                │
│  │ ☐ Developer mode              │                │
│  └─────────────────────────────────┘                │
│                                                     │
│ Click the toggle to turn it ON!                     │
└─────────────────────────────────────────────────────┘

┌─ Step 4: Load Unpacked Extension ───────────────────┐
│ ┌─────────────────────────────────────┐             │
│ │ Load unpacked...                   │             │
│ └─────────────────────────────────────┘             │
│                                                     │
│ Select: pdx_dark_protocol/extension/                │
└─────────────────────────────────────────────────────┘

┌─ Step 5: Success! ──────────────────────────────────┐
│ 🎉 PDX Dark extension is installed!                 │
│                                                     │
│ Click the 🕵️ icon in your toolbar                  │
└─────────────────────────────────────────────────────┘
```

**Happy privacy transferring!** 🛡️🔒
