# Email Setup Guide for NexusCrypto (Brevo SMTP)

## Problem: OTP emails are not being sent

If OTP emails aren't arriving, follow these steps to configure Brevo SMTP.

## Setup: Brevo SMTP Configuration

### Step 1: Create a Brevo Account
1. Sign up at [Brevo](https://www.brevo.com/) (free tier supports 300 emails/day)
2. Complete your account setup

### Step 2: Get SMTP Credentials
1. Go to **Settings → SMTP & API → SMTP** tab
2. Note the **Login** value (e.g. `a53e3f001@smtp-brevo.com`) — this is your `EMAIL_HOST_USER`
3. Click **"Generate a new SMTP key"**
4. Copy the generated key (starts with `xsmtpsib-...`) — this is your `EMAIL_HOST_PASSWORD`

### Step 3: Verify a Sender Email
1. Go to **Settings → Senders, Domains & Dedicated IPs → Senders**
2. Click **"Add a sender"**
3. Enter the email address you want to send from (e.g. your Gmail)
4. **Verify it** by clicking the confirmation link sent to that email
5. This verified email becomes your `DEFAULT_FROM_EMAIL`

### Step 4: Update .env File
Open `.env` in the project root and set:

```
EMAIL_HOST=smtp-relay.brevo.com
EMAIL_PORT=587
EMAIL_USE_TLS=True
EMAIL_HOST_USER=a53e3f001@smtp-brevo.com
EMAIL_HOST_PASSWORD=xsmtpsib-your-key-here
DEFAULT_FROM_EMAIL=your-verified-email@gmail.com
```

> **IMPORTANT**: `EMAIL_HOST_USER` must be the **Brevo SMTP Login** (not your Gmail).

### Step 5: Restart Server
Restart your Django development server for changes to take effect.

## Testing Email Setup

After updating `.env`:
1. Try the signup flow
2. Check the server terminal for success/error messages
3. Check email inbox **and spam folder**

## Development Mode (Without Email)

To test without email, set in `.env`:
```
EMAIL_BACKEND=django.core.mail.backends.console.EmailBackend
```
OTP codes will print in the terminal. In `DEBUG=True` mode, the OTP is also shown on the verification page.

## Troubleshooting

### Emails not sending
- Verify `EMAIL_HOST_USER` is the **Brevo SMTP Login** (e.g. `a53e3f001@smtp-brevo.com`), NOT your Gmail
- Verify `EMAIL_HOST_PASSWORD` is a valid Brevo SMTP key (starts with `xsmtpsib-`)
- Verify `DEFAULT_FROM_EMAIL` is a **verified sender** in Brevo

### Emails go to spam
- Check spam/junk folder
- Add a custom domain in Brevo for better deliverability

### Still not working?
- Check server terminal for detailed error messages
- Verify `.env` file is in the project root (same folder as `manage.py`)
- Make sure server was restarted after changing `.env`
