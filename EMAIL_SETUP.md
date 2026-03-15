# Email Setup Guide for NexusCrypto

## Problem: OTP emails are not being sent

If you're seeing errors like "Username and Password not accepted" or emails aren't being sent, follow these steps:

## Quick Fix: Set Up Gmail App Password

### Step 1: Enable 2-Step Verification
1. Go to [Google Account Security](https://myaccount.google.com/security)
2. Under "Signing in to Google", click **2-Step Verification**
3. Follow the prompts to enable it (if not already enabled)

### Step 2: Generate App Password
1. Go to [App Passwords](https://myaccount.google.com/apppasswords)
2. Select **Mail** from the "Select app" dropdown
3. Select **Other (Custom name)** from "Select device"
4. Type: `NexusCrypto`
5. Click **Generate**
6. **Copy the 16-character password** (it looks like: `abcd efgh ijkl mnop`)

### Step 3: Update .env File
1. Open `.env` file in the project root
2. Find the line: `EMAIL_HOST_PASSWORD=your-gmail-app-password-here`
3. Replace `your-gmail-app-password-here` with your 16-character app password
4. **Remove all spaces** from the password (it should be 16 characters with no spaces)
5. Save the file

Example:
```
EMAIL_HOST_PASSWORD=abcdefghijklmnop
```

### Step 4: Restart Server
Restart your Django development server for changes to take effect.

## Testing Email Setup

After updating `.env`:
1. Try the signup flow again
2. Check the server terminal - you should see: `✅ OTP email sent successfully to [email]`
3. Check your email inbox (and spam folder)

## Development Mode (Without Email)

If you want to test without setting up email:
1. In `.env`, change:
   ```
   EMAIL_BACKEND=django.core.mail.backends.console.EmailBackend
   ```
2. OTP codes will be printed in the terminal instead of sent via email
3. The OTP code is also shown on the verification page when `DEBUG=True`

## Troubleshooting

### Error: "Username and Password not accepted"
- Make sure you're using an **App Password**, not your regular Gmail password
- Verify 2-Step Verification is enabled
- Check that there are no spaces in the password in `.env`
- Make sure `.env` file is saved

### Error: "Less secure app access"
- Gmail no longer supports "less secure apps"
- You **must** use App Passwords (see steps above)

### Emails go to spam
- This is normal for new email senders
- Check your spam/junk folder
- The email is from `poosai270@gmail.com`

### Still not working?
- Check server terminal for detailed error messages
- Verify `.env` file is in the project root (same folder as `manage.py`)
- Make sure server was restarted after changing `.env`
- In DEBUG mode, OTP code is always shown on the verification page
