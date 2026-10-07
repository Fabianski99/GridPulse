export const CIRCUIT_RECORDS = {
  albert_park: {
    lapRecord: {
      time: "1:19.813",
      driver: "Charles Leclerc",
      year: 2024,
    },
  },

  shanghai: {
    lapRecord: {
      time: "1:32.238",
      driver: "Michael Schumacher",
      year: 2004,
    },
  },

  suzuka: {
    lapRecord: {
      time: "1:30.965",
      driver: "Kimi Antonelli",
      year: 2025,
    },
  },

  miami: {
    lapRecord: {
      time: "1:29.708",
      driver: "Max Verstappen",
      year: 2023,
    },
  },

  villeneuve: {
    lapRecord: {
      time: "1:13.078",
      driver: "Valtteri Bottas",
      year: 2019,
    },
  },

  monaco: {
    lapRecord: {
      time: "1:12.909",
      driver: "Lewis Hamilton",
      year: 2021,
    },
  },

  catalunya: {
    lapRecord: {
      time: "1:15.743",
      driver: "Oscar Piastri",
      year: 2025,
    },
  },

  red_bull_ring: {
    lapRecord: {
      time: "1:07.924",
      driver: "Oscar Piastri",
      year: 2025,
    },
  },

  silverstone: {
    lapRecord: {
      time: "1:27.097",
      driver: "Max Verstappen",
      year: 2020,
    },
  },

  spa: {
    lapRecord: {
      time: "1:44.701",
      driver: "Sergio Perez",
      year: 2024,
    },
  },

  hungaroring: {
    lapRecord: {
      time: "1:16.627",
      driver: "Lewis Hamilton",
      year: 2020,
    },
  },

  zandvoort: {
    lapRecord: {
      time: "1:11.097",
      driver: "Lewis Hamilton",
      year: 2021,
    },
  },

  monza: {
    lapRecord: {
      time: "1:20.901",
      driver: "Lando Norris",
      year: 2025,
    },
  },

  madring: {
    lapRecord: {
      time: "1:35.587",
      driver: "George Russell",
      year: 2026,
    },
  },

  baku: {
    lapRecord: {
      time: "1:43.009",
      driver: "Charles Leclerc",
      year: 2019,
    },
  },

  sepang: {
    lapRecord: {
      time: "1:34.080",
      driver: "Sebastian Vettel",
      year: 2017,
    },
  },

  marina_bay: {
    lapRecord: {
      time: "1:33.808",
      driver: "Lewis Hamilton",
      year: 2025,
    },
  },

  americas: {
    lapRecord: {
      time: "1:36.169",
      driver: "Charles Leclerc",
      year: 2019,
    },
  },

  rodriguez: {
    lapRecord: {
      time: "1:17.774",
      driver: "Valtteri Bottas",
      year: 2021,
    },
  },

  interlagos: {
    lapRecord: {
      time: "1:10.540",
      driver: "Valtteri Bottas",
      year: 2018,
    },
  },

  vegas: {
    lapRecord: {
      time: "1:33.365",
      driver: "Max Verstappen",
      year: 2025,
    },
  },

  losail: {
    lapRecord: {
      time: "1:22.384",
      driver: "Lando Norris",
      year: 2024,
    },
  },

  yas_marina: {
    lapRecord: {
      time: "1:26.103",
      driver: "Max Verstappen",
      year: 2021,
    },
  },

  portimao: {
    lapRecord: {
      time: "1:18.750",
      driver: "Lewis Hamilton",
      year: 2020,
    },
  },

  istanbul: {
    lapRecord: {
      time: "1:24.770",
      driver: "Juan Pablo Montoya",
      year: 2005,
    },
  },
};

export function getCircuitRecord(circuitId) {
  return CIRCUIT_RECORDS[circuitId] ?? null;
}