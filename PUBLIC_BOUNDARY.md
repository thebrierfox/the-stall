# Public integration boundary

This repository intentionally contains only material needed to find, inspect,
pay, call, and integrate with the hosted STALL service:

- endpoint and protocol documentation;
- public payment identity and buyer-side validation rules;
- generated discovery metadata and schemas already exposed by the live service;
- bounded buyer examples and their synthetic tests; and
- a read-only live acceptance probe.

It intentionally excludes the seller implementation and internal operations,
including capability handlers, supplier selection, acquisition logic, pricing
and repricing systems, payment/settlement internals, registry implementation,
commercial loops, attribution internals, experiments, tests of private seller
behavior, runtime logs and data, credentials, deployment configuration, and
strategy.

The MIT license in this repository applies only to the files actually present
in this repository. It grants no rights to separately held backend software or
private operational material.
