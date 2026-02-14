/**
 * WP Membership Certificate – Front-end JS
 *
 * Uses html2canvas to snapshot the certificate element, then
 * jsPDF to convert it into a downloadable PDF.
 */
(function ($) {
    'use strict';

    /* ── Generate & Download PDF ──────────────── */
    $(document).on('click', '#wmcert-download-btn', function (e) {
        e.preventDefault();

        var $btn     = $(this);
        var $loading = $('#wmcert-loading');
        var certEl   = document.getElementById('wmcert-certificate');

        if (!certEl) {
            alert('Certificate element not found.');
            return;
        }

        // Disable button, show spinner
        $btn.prop('disabled', true).css('opacity', 0.6);
        $loading.fadeIn(200);

        // html2canvas options
        html2canvas(certEl, {
            scale: 2,                   // Higher resolution
            useCORS: true,
            backgroundColor: '#fffef8',
            logging: false,
            windowWidth: 960,
        }).then(function (canvas) {

            var imgData  = canvas.toDataURL('image/png');
            var { jsPDF } = window.jspdf;

            // A4 landscape dimensions in mm
            var pdf = new jsPDF({
                orientation: 'landscape',
                unit: 'mm',
                format: 'a4',
            });

            var pageW = pdf.internal.pageSize.getWidth();    // 297
            var pageH = pdf.internal.pageSize.getHeight();   // 210

            // Scale image to fit A4 landscape with margins
            var margin  = 10;
            var imgW    = pageW - margin * 2;
            var imgH    = (canvas.height * imgW) / canvas.width;

            // If scaled height exceeds page, scale down further
            if (imgH > pageH - margin * 2) {
                imgH = pageH - margin * 2;
                imgW = (canvas.width * imgH) / canvas.height;
            }

            // Center the image
            var xOffset = (pageW - imgW) / 2;
            var yOffset = (pageH - imgH) / 2;

            pdf.addImage(imgData, 'PNG', xOffset, yOffset, imgW, imgH);
            pdf.save('Membership-Certificate.pdf');

            // Re-enable
            $btn.prop('disabled', false).css('opacity', 1);
            $loading.fadeOut(200);

        }).catch(function (err) {
            console.error('Certificate generation failed:', err);
            alert('Sorry, certificate generation failed. Please try again.');
            $btn.prop('disabled', false).css('opacity', 1);
            $loading.fadeOut(200);
        });
    });

    /* ── Print ────────────────────────────────── */
    $(document).on('click', '#wmcert-print-btn', function (e) {
        e.preventDefault();
        window.print();
    });

})(jQuery);
