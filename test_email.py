"""Quick test script to verify Brevo SMTP connectivity."""
import smtplib
from email.mime.text import MIMEText
from decouple import config

HOST = config('EMAIL_HOST', default='smtp-relay.brevo.com')
PORT = config('EMAIL_PORT', default=587, cast=int)
USER = config('EMAIL_HOST_USER', default='')
PASS = config('EMAIL_HOST_PASSWORD', default='')
FROM_EMAIL = config('DEFAULT_FROM_EMAIL', default='')

print(f"SMTP Server: {HOST}:{PORT}")
print(f"Login: {USER}")
print(f"From: {FROM_EMAIL}")
print(f"Password length: {len(PASS)}")
print()

if not USER or not PASS:
    print("ERROR: EMAIL_HOST_USER or EMAIL_HOST_PASSWORD not set in .env")
    exit(1)

# Send to yourself for testing
TO_EMAIL = FROM_EMAIL or USER

msg = MIMEText("This is a test email from NexusCrypto. If you received this, Brevo SMTP is working!")
msg['Subject'] = 'NexusCrypto - SMTP Test'
msg['From'] = FROM_EMAIL
msg['To'] = TO_EMAIL

try:
    server = smtplib.SMTP(HOST, PORT)
    server.set_debuglevel(1)
    
    print("Starting TLS...")
    server.starttls()
    
    print(f"Logging in as {USER}...")
    server.login(USER, PASS)
    
    print(f"Sending test email to {TO_EMAIL}...")
    server.send_message(msg)
    
    print("\n✅ Email sent successfully! Check your inbox.")
    server.quit()
except smtplib.SMTPAuthenticationError as e:
    print(f"\n❌ Authentication failed: {e}")
    print("Check that EMAIL_HOST_USER is your Brevo SMTP Login (e.g. a53e3f001@smtp-brevo.com)")
    print("Check that EMAIL_HOST_PASSWORD is a valid Brevo SMTP key (starts with xsmtpsib-)")
except Exception as e:
    print(f"\n❌ Error: {e}")
