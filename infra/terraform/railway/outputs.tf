output "custom_domain_dns" {
  description = <<-EOT
    DNS records to create at the registrar (Namecheap) for each custom domain: a CNAME
    `host_label` -> `dns_record_value`, and, when Railway asks for ownership proof, a TXT record
    `verification_host_label` -> `verification_record_value`.
  EOT
  value = {
    for key, d in {
      pay = railway_custom_domain.pay
      app = railway_custom_domain.app
      api = railway_custom_domain.api
      } : key => {
      domain                    = d.domain
      zone                      = d.zone
      host_label                = d.host_label
      dns_record_value          = d.dns_record_value
      verification_host_label   = d.verification_host_label
      verification_record_value = d.verification_record_value
    }
  }
}
