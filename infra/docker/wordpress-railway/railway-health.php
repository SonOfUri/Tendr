<?php
// Container liveness only. Store/database readiness is checked during migration verification.
header( 'Content-Type: text/plain; charset=utf-8' );
header( 'Cache-Control: no-store' );
echo "ok\n";
