<?php defined( 'ABSPATH' ) || exit; ?>
<!doctype html>
<html <?php language_attributes(); ?>>
<head>
<meta charset="<?php bloginfo( 'charset' ); ?>">
<meta name="viewport" content="width=device-width, initial-scale=1">
<?php wp_head(); ?>
</head>
<body <?php body_class(); ?>>
<?php wp_body_open(); ?>
<a class="skip-link screen-reader-text" href="#content">Skip to content</a>
<div id="page" class="hfeed site">
    <div class="fashion-announcement">UNOFFICIAL ZARA-INSPIRED CONCEPT STORE · A TENDR CHECKOUT DEMO</div>
    <header class="fashion-header">
        <div class="fashion-header-row">
            <?php tendr_fashion_search( 'fashion-search-desktop' ); ?>
            <details class="fashion-mobile-menu">
                <summary>Menu</summary>
                <nav aria-label="Mobile collection"><?php tendr_fashion_navigation(); tendr_fashion_search( 'fashion-search-mobile' ); ?></nav>
            </details>
            <div class="fashion-brand"><a class="fashion-wordmark" href="<?php echo esc_url( home_url( '/' ) ); ?>" aria-label="Zara concept demo home">ZARA</a><small>THE CONCEPT STORE</small></div>
            <div class="fashion-actions">
                <a class="fashion-account" href="<?php echo esc_url( wc_get_page_permalink( 'myaccount' ) ); ?>">Account</a>
                <a href="<?php echo esc_url( wc_get_cart_url() ); ?>"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M5 7h14l1 15H4L5 7Z"/><path d="M8 8V5a4 4 0 0 1 8 0v3"/></svg> Bag</a>
            </div>
        </div>
        <nav class="fashion-nav" aria-label="Collection"><?php tendr_fashion_navigation(); ?></nav>
    </header>
    <?php if ( ! is_front_page() ) { do_action( 'storefront_before_content' ); } ?>
    <div id="content" class="site-content" tabindex="-1"><div class="col-full">
    <?php do_action( 'storefront_content_top' ); ?>
