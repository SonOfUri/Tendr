output "project_id" {
  value = railway_project.tendr.id
}

output "environment_id" {
  value = local.environment_id
}

output "service_ids" {
  value = {
    api      = railway_service.api.id
    worker   = railway_service.worker.id
    web      = railway_service.web.id
    postgres = railway_service.postgres.id
    redis    = railway_service.redis.id
  }
}

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
