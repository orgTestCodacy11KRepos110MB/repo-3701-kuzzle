---
code: true
type: page
title: zunionstore | API | Core
---

# zunionstore



Computes the union of the provided sorted sets, and stores the result in a new sorted set.

[[_Redis documentation_]](https://redis.io/commands/zunionstore)

---

## Query Syntax

### HTTP

```http
URL: http://kuzzle:7512/ms/_zunionstore/<_id>
Method: POST
Body:
```

```js
{
  "keys": ["key1", "key2", "..."],
  // optional
  "weights": ["weight1", "weight2", "..."],
  "aggregate": "[sum|min|max]"
}
```

### Other protocols

```js
{
  "controller": "ms",
  "action": "zunionstore",
  "_id": "<key>",
  "body": {
    "keys": ["key1", "key2", "..."],
    // optional
    "weights": ["weight1", "weight2", "..."],
    "aggregate": "[sum|min|max]"
  }
}
```

---

## Argument

- `_id`: sorted set to create/overwrite with the computed intersection

---

## Body properties

### Optional:

- `aggregate` (default: `sum`): specifies how members' scores are aggregated during the union
- `weights`: specifies a multiplication factor for each input sorted set

---

## Response

Returns the number of members added to the destination sorted set.

```js
{
  "requestId": "<unique request identifier>",
  "status": 200,
  "error": null,
  "controller": "ms",
  "action": "zunionstore",
  "collection": null,
  "index": null,
  "result": 31
}
```
