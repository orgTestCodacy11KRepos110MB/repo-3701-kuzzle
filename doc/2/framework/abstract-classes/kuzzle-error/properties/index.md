---
code: true
type: page
title: Properties | Framework | Core

description: KuzzleError abstract class properties
---

# Properties

| Name              | Type          | Description |
|-------------------|---------------|-------------|
| `code`         | <pre>number</pre> | Error unique code |
| `id`           | <pre>string</pre> | Error unique name |
| `name`         | <pre>string</pre> | Error class name (`KuzzleError`) |
| `message`      | <pre>string</pre> | Error message  |
| `stack`        | <pre>string</pre> | Error stack trace |
| `status`       | <pre>number</pre> | Error status code (Kuzzle's API errors follow the HTTP standard) |
