---
code: true
type: page
title: list | API | Core
---

# list

Returns the list of collections associated to a provided index.

The returned list is sorted in alphanumerical order.

---

## Query Syntax

### HTTP

```http
URL: http://kuzzle:7512/<index>/_list[?type=<all|stored|realtime>]
Method: GET
```

### Other protocols

```js
{
  "index": "<index>",
  "controller": "collection",
  "action": "list",
  "type": "stored"
}
```

---

## Arguments

- `collection`: collection name
- `index`: index name


### Optional:

- `from` and `size`: response pagination <DeprecatedBadge version="2.1.4" />
- `type`: filters the returned collections. Allowed values: `all`, `stored` and `realtime` (default : `all`). <DeprecatedBadge version="2.10.2" />

---

## Response

Returns an array of objects, each one of those describing a collection, using the following properties:

- `name`: collection name
- `type`: collection type (either `stored` or `realtime`)

Example:

```js
{
  "status": 200,
  "error": null,
  "index": "<index>",
  "controller": "collection",
  "action": "list",
  "requestId": "<unique request identifier>",
  "result": {
    "collections": [
      {
        "name": "realtime_1", "type": "realtime"
      },
      {
        "name": "realtime_2", "type": "realtime"
      },
      {
        "name": "realtime_...", "type": "realtime"
      },
      {
        "name": "realtime_n", "type": "realtime"
      },
      {
        "name": "stored_1", "type": "stored"
      },
      {
        "name": "stored_2", "type": "stored"
      },
      {
        "name": "stored_...", "type": "stored"
      },
      {
        "name": "stored_n", "type": "stored"
      }
    ],
    "type": "all"
  }
}
```

---

## Possible errors

- [Common errors](/core/2/api/errors/types#common-errors)
- [NotFoundError](/core/2/api/errors/types#notfounderror)

