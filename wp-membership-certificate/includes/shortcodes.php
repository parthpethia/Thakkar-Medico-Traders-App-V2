<?php
/**
 * Shortcodes – [membership_dashboard]
 *
 * Renders the member dashboard with certificate preview & download button.
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

add_shortcode( 'membership_dashboard', 'wmcert_dashboard_shortcode' );

function wmcert_dashboard_shortcode( $atts ) {
    if ( ! is_user_logged_in() ) {
        return '<div class="wmcert-notice wmcert-notice--warning">Please <a href="' . esc_url( wp_login_url( get_permalink() ) ) . '">log in</a> to access your member dashboard.</div>';
    }

    $user_id = get_current_user_id();
    $data    = wmcert_get_membership_data( $user_id );

    if ( ! $data ) {
        return '<div class="wmcert-notice wmcert-notice--info">You don\'t have an active membership yet. <a href="' . esc_url( wc_get_page_permalink( 'shop' ) ) . '">Purchase a membership</a> to get started.</div>';
    }

    // Settings
    $cert_title     = get_option( 'wmcert_certificate_title', 'Certificate of Membership' );
    $org_name       = get_option( 'wmcert_organization_name', get_bloginfo( 'name' ) );
    $cert_message   = get_option( 'wmcert_certificate_message', 'This is to certify that the above-named person is a registered member of our organization.' );
    $signatory_name = get_option( 'wmcert_signatory_name', '' );
    $signatory_title = get_option( 'wmcert_signatory_title', 'Director' );

    ob_start();
    ?>
    <div class="wmcert-dashboard">

        <!-- ── Member Info Card ──────────────────── -->
        <div class="wmcert-info-card">
            <h2>👋 Welcome, <?php echo esc_html( $data['full_name'] ); ?>!</h2>
            <table class="wmcert-info-table">
                <tr>
                    <th>Membership ID</th>
                    <td><code><?php echo esc_html( $data['membership_id'] ); ?></code></td>
                </tr>
                <tr>
                    <th>Member Name</th>
                    <td><?php echo esc_html( $data['full_name'] ); ?></td>
                </tr>
                <tr>
                    <th>Email</th>
                    <td><?php echo esc_html( $data['email'] ); ?></td>
                </tr>
                <tr>
                    <th>Member Since</th>
                    <td><?php echo esc_html( $data['formatted_date'] ); ?></td>
                </tr>
            </table>
        </div>

        <!-- ── Certificate Preview ───────────────── -->
        <h3 class="wmcert-section-title">Your Membership Certificate</h3>
        <p class="wmcert-hint">Click <strong>"Generate &amp; Download Certificate"</strong> to download a PDF version.</p>

        <div id="wmcert-certificate" class="wmcert-certificate">
            <!-- Decorative border layers -->
            <div class="wmcert-border-outer">
                <div class="wmcert-border-inner">
                    <div class="wmcert-content">

                        <!-- Logo / Org Name -->
                        <div class="wmcert-org-name"><?php echo esc_html( $org_name ); ?></div>

                        <!-- Title -->
                        <h1 class="wmcert-title"><?php echo esc_html( $cert_title ); ?></h1>

                        <div class="wmcert-divider"></div>

                        <!-- Body -->
                        <p class="wmcert-presented">This certificate is proudly presented to</p>

                        <h2 class="wmcert-member-name"><?php echo esc_html( $data['full_name'] ); ?></h2>

                        <p class="wmcert-message"><?php echo esc_html( $cert_message ); ?></p>

                        <!-- Details row -->
                        <div class="wmcert-details-row">
                            <div class="wmcert-detail">
                                <span class="wmcert-detail-label">Membership ID</span>
                                <span class="wmcert-detail-value"><?php echo esc_html( $data['membership_id'] ); ?></span>
                            </div>
                            <div class="wmcert-detail">
                                <span class="wmcert-detail-label">Date of Issue</span>
                                <span class="wmcert-detail-value"><?php echo esc_html( $data['formatted_date'] ); ?></span>
                            </div>
                        </div>

                        <div class="wmcert-divider"></div>

                        <!-- Signature area -->
                        <div class="wmcert-signature-row">
                            <div class="wmcert-signature">
                                <?php if ( $signatory_name ) : ?>
                                    <div class="wmcert-sig-line"><?php echo esc_html( $signatory_name ); ?></div>
                                <?php else : ?>
                                    <div class="wmcert-sig-line">&nbsp;</div>
                                <?php endif; ?>
                                <div class="wmcert-sig-title"><?php echo esc_html( $signatory_title ); ?></div>
                            </div>
                            <div class="wmcert-seal">
                                <div class="wmcert-seal-circle">
                                    <span>CERTIFIED</span>
                                    <span class="wmcert-seal-sub">MEMBER</span>
                                </div>
                            </div>
                        </div>

                    </div><!-- .wmcert-content -->
                </div><!-- .wmcert-border-inner -->
            </div><!-- .wmcert-border-outer -->
        </div><!-- #wmcert-certificate -->

        <!-- ── Action Buttons ────────────────────── -->
        <div class="wmcert-actions">
            <button id="wmcert-download-btn" class="wmcert-btn wmcert-btn--primary">
                📄 Generate &amp; Download Certificate (PDF)
            </button>
            <button id="wmcert-print-btn" class="wmcert-btn wmcert-btn--secondary">
                🖨️ Print Certificate
            </button>
        </div>

        <div id="wmcert-loading" class="wmcert-loading" style="display:none;">
            <div class="wmcert-spinner"></div>
            <span>Generating your certificate…</span>
        </div>

    </div><!-- .wmcert-dashboard -->
    <?php
    return ob_get_clean();
}
