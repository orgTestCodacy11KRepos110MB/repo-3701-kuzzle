---
code: true
type: page
title: Constructor | Framework | Core

description: ServiceUnavailableError class constructor
---

# ServiceUnavailableError

Inherits from [KuzzleError](/core/2/framework/abstract-classes/kuzzle-error/constructor).

This error object is used when an action is temporarily unavailable.


```ts
constructor(message: string, id?: string, code?: number)
```

<br/>

| Argument       | Type      | Description            |
| -------------- | --------- | ---------------------- |
| `message`      | <pre>string</pre> | Error message  |
| `id`           | <pre>string</pre> | (optional) Error unique name |
| `code`         | <pre>number</pre> | (optional) Error unique code |
