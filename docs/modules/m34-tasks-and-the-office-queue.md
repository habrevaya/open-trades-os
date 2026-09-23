---
title: Tasks and the Office Work Queue
module: M34
domain: Company
phase: 6
status: stub
---

# Tasks and the Office Work Queue

> Module M34. Domain: Company. Ships in phase 6.

## The problem

The work that is not a job: call this customer back, chase this approval, this invoice needs a purchase order before it can be sent, somebody promised a quote on Friday.

## What it does

A task queue for office work. Created by a person or raised by the workflow
engine, assigned to somebody or to a queue, due dated, escalating and
reportable.

Tasks attach to the record they are about, so following one up opens the
estimate rather than a sentence describing it.

## Key concepts

**A task hangs off the record it is about.** A to-do list of sentences makes
somebody reconstruct the context before they can act, and the reconstruction is
most of the work.

**The workflow engine raises most of them.** Relying on a person to notice that
an estimate went unanswered for five days is relying on a report nobody runs.
The events are already in the log; a task is what turns one into something
somebody actually sees.

**Where the money leaks.** An unapproved estimate nobody followed up is a sale
that did not happen and leaves no record that it existed. That is the case this
module is for.

## Setup

<!-- What an admin configures, in order, with the permissions required. -->

## Using it

<!-- Task-oriented. One heading per job to be done. -->

## Permissions

| Role | Access |
|---|---|
<!-- owner / admin / manager / dispatcher / csr / technician / accountant -->

## API

<!-- Link to the generated reference, plus the two or three calls that
     cover most real integrations. -->
