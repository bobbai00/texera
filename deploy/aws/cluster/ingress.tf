# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

# The way in: a network load balancer in the public subnets, sending to the gateway Service's node
# port on every node (kube-proxy forwards to the gateway pod). It is made here, before the stack,
# so that its name is the public URL the stack is configured with, and so that TLS is a listener
# and a certificate here, not a change inside the cluster. Without a domain, port 80 carries the
# app; with one, 443 does and 80 is a listener of the gateway that only redirects.

resource "aws_vpc_security_group_ingress_rule" "node_ports" {
  security_group_id = aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
  description       = "the gateway node ports, from the load balancer"
  ip_protocol       = "tcp"
  from_port         = local.app_node_port
  to_port           = local.redirect_node_port
  cidr_ipv4         = var.vpc_cidr
}

resource "aws_lb" "this" {
  name                             = var.name
  load_balancer_type               = "network"
  internal                         = false
  subnets                          = aws_subnet.public[*].id
  enable_cross_zone_load_balancing = true
}

resource "aws_lb_target_group" "app" {
  name                 = "${var.name}-app"
  port                 = local.app_node_port
  protocol             = "TCP"
  target_type          = "instance"
  vpc_id               = aws_vpc.this.id
  preserve_client_ip   = false
  deregistration_delay = 30
  health_check {
    protocol            = "TCP"
    interval            = 10
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
}

resource "aws_lb_target_group" "redirect" {
  count                = local.tls ? 1 : 0
  name                 = "${var.name}-redirect"
  port                 = local.redirect_node_port
  protocol             = "TCP"
  target_type          = "instance"
  vpc_id               = aws_vpc.this.id
  preserve_client_ip   = false
  deregistration_delay = 30
  health_check {
    protocol            = "TCP"
    interval            = 10
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
}

# Every node of the group is a target, as the group scales.
resource "aws_autoscaling_attachment" "app" {
  autoscaling_group_name = aws_eks_node_group.general.resources[0].autoscaling_groups[0].name
  lb_target_group_arn    = aws_lb_target_group.app.arn
}

resource "aws_autoscaling_attachment" "redirect" {
  count                  = local.tls ? 1 : 0
  autoscaling_group_name = aws_eks_node_group.general.resources[0].autoscaling_groups[0].name
  lb_target_group_arn    = aws_lb_target_group.redirect[0].arn
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "TCP"
  default_action {
    type             = "forward"
    target_group_arn = local.tls ? aws_lb_target_group.redirect[0].arn : aws_lb_target_group.app.arn
  }
}

resource "aws_lb_listener" "https" {
  count             = local.tls ? 1 : 0
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "TLS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.this[0].certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}
