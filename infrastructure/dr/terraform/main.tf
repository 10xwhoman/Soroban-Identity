# Secondary-region warm standby (#959). See ../secondary-region.md.
#
# Reuses the same root module as every environment, so the standby cannot
# drift from production except through the variables below. The ECS service
# runs zero tasks until failover scales it up.
terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  backend "s3" {}
}

variable "environment" {
  type    = string
  default = "production"
}
variable "primary_region" {
  type    = string
  default = "us-east-1"
}
variable "secondary_region" {
  type    = string
  default = "us-west-2"
}
variable "app_image" {
  type        = string
  description = "Must match the production image digest."
}
variable "standby_desired_count" {
  type    = number
  default = 0
}

module "standby" {
  source             = "../../../infra/terraform"
  environment        = "${var.environment}-dr"
  aws_region         = var.secondary_region
  availability_zones = ["${var.secondary_region}a", "${var.secondary_region}b", "${var.secondary_region}c"]
  vpc_cidr           = "10.40.0.0/16"
  redis_node_type    = "cache.r7g.large"
  redis_replicas     = 2
  app_image          = var.app_image
  app_desired_count  = var.standby_desired_count
}

output "standby_redis_endpoint" { value = module.standby.redis_endpoint }
