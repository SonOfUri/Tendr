<?php defined( 'ABSPATH' ) || exit; get_header(); ?>
<main id="main" class="fashion-home">
    <section class="fashion-hero" aria-labelledby="fashion-hero-title">
        <img src="<?php echo esc_url( tendr_fashion_asset( 'hero' ) ); ?>" width="1536" height="1024" fetchpriority="high" alt="Two models in a chocolate draped dress and sand overshirt in a sunlit courtyard">
        <div class="fashion-hero-copy"><p class="fashion-eyebrow">The everyday edit / Collection 01</p>
            <h1 id="fashion-hero-title">The art of<br><em>everyday.</em></h1>
            <p class="fashion-hero-description">Considered shapes. Quiet textures.<br>Pieces for wherever the day takes you.</p>
            <a class="fashion-button" href="<?php echo esc_url( wc_get_page_permalink( 'shop' ) ); ?>">Explore the collection <span aria-hidden="true">↗</span></a>
        </div>
        <span class="fashion-hero-index">A STUDY IN SOFT CONTRASTS — 01 / 06</span>
    </section>
    <div class="fashion-strip"><span>Woman · Man · Everyday essentials</span><span>Six pieces. Endless possibilities.</span><span>Discover the Tendr checkout experience ↗</span></div>
    <section class="fashion-section" id="collection" aria-labelledby="fashion-collection-title">
        <div class="fashion-section-heading"><div><p class="fashion-eyebrow">Selected for you</p><h2 id="fashion-collection-title">The new essentials.</h2></div><a class="fashion-text-link" href="<?php echo esc_url( wc_get_page_permalink( 'shop' ) ); ?>">View all pieces ↗</a></div>
        <div class="fashion-grid">
            <?php foreach ( array( 'KNIT', 'OVERSHIRT', 'TROUSERS', 'DRESS' ) as $sku ) {
                $product = wc_get_product( wc_get_product_id_by_sku( 'TENDR-FASHION-' . $sku ) );
                if ( $product ) { tendr_fashion_card( $product ); }
            } ?>
        </div>
    </section>
    <section class="fashion-story" aria-labelledby="fashion-story-title">
        <div class="fashion-story-image"><img src="<?php echo esc_url( tendr_fashion_asset( 'hero' ) ); ?>" alt="Relaxed tailoring and fluid silhouettes from the everyday edit" loading="lazy" width="1536" height="1024"></div>
        <div class="fashion-story-copy"><p class="fashion-eyebrow">Less, but considered.</p><h2 id="fashion-story-title">A slower<br>kind of<br><em>statement.</em></h2><p>Soft tailoring, tactile layers, and a palette borrowed from the everyday. An edit designed to work together, and feel entirely your own.</p><a class="fashion-text-link" href="<?php echo esc_url( home_url( '/the-concept/' ) ); ?>">Inside the concept ↗</a></div>
    </section>
</main>
<?php get_footer(); ?>
