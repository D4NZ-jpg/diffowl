---
title: Introduction
description: What Diffowl reviews, what it returns, and where human judgment remains essential.
---

Diffowl is a self-hostable pull-request review system for small, AI-accelerated product teams. Review OWL runs an evidence-backed first pass so a person can focus on product judgment and material findings.

## The product promise

For every eligible pull request, Diffowl:

1. classifies the execution context before risky work begins;
2. loads review policy from the trusted base revision;
3. runs reviewer, challenger, and verifier roles;
4. normalizes supported claims into material findings or advisory suggestions;
5. returns a typed outcome that preserves incomplete, limited, and failed states;
6. publishes actionable findings through GitHub when the trust class permits it.

## Material findings and advice

A **material finding** claims that a change causes a meaningful problem. It includes a location, impact, evidence, lifecycle state, and verification state. Material findings affect review readiness.

An **advisory suggestion** is a non-blocking improvement. Advice remains separate so style preferences and optional polish do not masquerade as defects.

## What Diffowl does not do

Diffowl does not provide:

- a correctness guarantee;
- autonomous merge authority;
- default automated approval;
- a hosted dashboard or required hosted service;
- broad coding-agent behavior or automatic patch application;
- first-class support for GitLab, Bitbucket, or Azure DevOps in V1.

:::note[The human handoff]
A successful Diffowl run means the pull request is ready for targeted human review. It does not mean the pull request is safe to merge without review.
:::

## Choose a path

- [Install the GitHub Action](../quick-start/)
- [Run the local CLI](../../guides/local-cli/)
- [Understand trust and security](../../security/trust-model/)
- [Read the architecture](../../project/architecture/)
