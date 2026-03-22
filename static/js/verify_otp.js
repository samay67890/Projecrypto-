/**
 * OTP Verification Page — Input handling, paste support, resend timer.
 * Integrates with Django form by populating a hidden #otp-value field.
 */
document.addEventListener('DOMContentLoaded', () => {
    const inputs = document.querySelectorAll('.otp-input-group input');
    const form = document.getElementById('verify-otp-form');
    const hiddenOtp = document.getElementById('otp-value');
    const verifyBtn = document.getElementById('verify-btn');
    const resendBtn = document.getElementById('resend-btn');

    // ── Sync hidden field ──
    function syncOtp() {
        const code = Array.from(inputs).map(i => i.value).join('');
        if (hiddenOtp) hiddenOtp.value = code;
        return code;
    }

    // ── Input handler ──
    inputs.forEach((input, index) => {
        input.addEventListener('input', (e) => {
            const value = e.target.value;

            // Only allow digits
            if (!/^[0-9]$/.test(value)) {
                e.target.value = '';
                e.target.classList.remove('filled');
                syncOtp();
                return;
            }

            e.target.classList.add('filled');
            e.target.classList.remove('error');

            // Move to next input
            if (value !== '' && index < inputs.length - 1) {
                inputs[index + 1].focus();
            }

            syncOtp();
        });

        // ── Backspace navigation ──
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace') {
                e.target.classList.remove('filled');
                if (e.target.value === '' && index > 0) {
                    inputs[index - 1].focus();
                    inputs[index - 1].value = '';
                    inputs[index - 1].classList.remove('filled');
                }
                // Sync after a tiny delay so the value is cleared
                setTimeout(syncOtp, 10);
            }
        });

        // ── Paste support ──
        input.addEventListener('paste', (e) => {
            e.preventDefault();
            const pasted = e.clipboardData.getData('text').replace(/\D/g, '').substring(0, inputs.length);

            if (pasted) {
                [...pasted].forEach((char, i) => {
                    if (inputs[i]) {
                        inputs[i].value = char;
                        inputs[i].classList.add('filled');
                        inputs[i].classList.remove('error');
                    }
                });

                const nextIdx = Math.min(pasted.length, inputs.length - 1);
                inputs[nextIdx].focus();
                syncOtp();
            }
        });

        // ── Click to select content ──
        input.addEventListener('click', () => {
            input.select();
        });
    });

    // ── Form submit — validate before sending ──
    if (form) {
        form.addEventListener('submit', (e) => {
            const code = syncOtp();

            if (code.length !== inputs.length) {
                e.preventDefault();

                // Flash empty inputs red
                inputs.forEach(input => {
                    if (!input.value) {
                        input.classList.add('error');
                        setTimeout(() => input.classList.remove('error'), 1200);
                    }
                });
                return;
            }

            // Disable button to prevent double submit
            if (verifyBtn) {
                verifyBtn.disabled = true;
                verifyBtn.textContent = 'Verifying...';
            }
        });
    }

    // ── Resend countdown timer ──
    if (resendBtn) {
        let timeLeft = 59;
        const originalHref = resendBtn.getAttribute('href');
        const originalText = resendBtn.textContent;

        // Disable during countdown
        resendBtn.classList.add('disabled');
        resendBtn.removeAttribute('href');
        resendBtn.textContent = `Resend (${timeLeft}s)`;

        const timer = setInterval(() => {
            timeLeft -= 1;
            if (timeLeft <= 0) {
                clearInterval(timer);
                resendBtn.textContent = originalText;
                resendBtn.classList.remove('disabled');
                resendBtn.setAttribute('href', originalHref);
            } else {
                resendBtn.textContent = `Resend (${timeLeft}s)`;
            }
        }, 1000);
    }
});
