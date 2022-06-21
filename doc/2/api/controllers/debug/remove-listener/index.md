---
code: true
type: page
title: removeListener
---

# removeListener

Stop listening to a specific events from the Debug Controller.

---

:::warn
This only works using a Websocket connection since notification can only be sent on a persisted connection.
:::

## Query Syntax

### Websocket protocol

```js
{
  "controller": "debug",
  "action": "removeListener",
  "body": {
    "event": "<event name>"
  }
}
```

- `event`: event name to stop listening to.

## Response


```js
{
  "status": 200,
  "error": null,
  "controller": "debug",
  "action": "removeListener",
  "requestId": "<unique request identifier>",
}
```