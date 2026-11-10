FROM wordpress:cli-php8.3 AS wpcli
FROM wordpress:7.1.4-php8.3-apache

# WP-CLI and a database client support imports, backups and URL changes over Railway SSH.
RUN apt-get update \
    && apt-get install -y --no-install-recommends mariadb-client \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
COPY --from=wpcli /usr/local/bin/wp /usr/local/bin/wp
COPY uploads.ini /usr/local/etc/php/conf.d/tendr-store.ini
COPY apache-limits.conf /etc/apache2/conf-available/tendr-store.conf
RUN a2enconf tendr-store
COPY railway-health.php /usr/src/wordpress/railway-health.php
COPY entrypoint.sh /usr/local/bin/tendr-wordpress-entrypoint
RUN chmod +x /usr/local/bin/tendr-wordpress-entrypoint

# Keep WordPress, plugins, uploads and configuration on a Railway volume at /var/www/html.
# Secrets, database exports and the existing store's files are transferred separately.
EXPOSE 80
ENTRYPOINT ["tendr-wordpress-entrypoint"]
CMD ["apache2-foreground"]
