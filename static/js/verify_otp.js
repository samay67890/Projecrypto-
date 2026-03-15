(function () {
    var form = document.getElementById('verify-otp-form');
    var inputs = document.querySelectorAll('.otp-input');
    var hiddenOtp = document.getElementById('otp-value');

    if (!inputs.length) return;

    function getOtpString() {
        return Array.prototype.map.call(inputs, function (inp) { return inp.value || ''; }).join('');
    }

    function setHiddenOtp(value) {
        if (hiddenOtp) hiddenOtp.value = value;
    }

    // Auto-focus and single-digit input
    inputs.forEach(function (input, index) {
        input.addEventListener('keyup', function (e) {
            if (e.key >= '0' && e.key <= '9') {
                input.value = e.key;
                setHiddenOtp(getOtpString());
                if (index < inputs.length - 1) inputs[index + 1].focus();
            } else if (e.key === 'Backspace') {
                input.value = '';
                setHiddenOtp(getOtpString());
                if (index > 0) inputs[index - 1].focus();
            }
        });

        input.addEventListener('paste', function (e) {
            e.preventDefault();
            var pasted = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 6);
            for (var i = 0; i < pasted.length && i < inputs.length; i++) {
                inputs[i].value = pasted[i];
            }
            setHiddenOtp(getOtpString());
            if (pasted.length > 0 && pasted.length < inputs.length) {
                inputs[pasted.length].focus();
            } else if (pasted.length >= inputs.length) {
                inputs[inputs.length - 1].focus();
            }
        });
    });

    // On submit: ensure combined OTP is in hidden input
    if (form) {
        form.addEventListener('submit', function () {
            setHiddenOtp(getOtpString());
        });
    }
})();
