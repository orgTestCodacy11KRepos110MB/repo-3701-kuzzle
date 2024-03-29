"use strict";

// See https://docs.kuzzle.io/core/2/api/controllers/admin/load-securities/

module.exports = {
  users: {
    "test-admin": {
      content: {
        profileIds: ["admin"],
      },
      credentials: {
        local: {
          username: "test-admin",
          password: "password",
        },
      },
    },
    "default-user": {
      content: {
        profileIds: ["default"],
      },
      credentials: {
        local: {
          username: "default-user",
          password: "password",
        },
      },
    },
  },
};
