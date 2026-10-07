import { useMemo, useRef, useState } from "react";
import "./Circuits.css";
import { getCircuitRecord } from "./CircuitRecords";
import { CIRCUIT_TRACKS } from "./CircuitTracks";
import SegmentedCircuit from "./SegmentedCircuit";

const API = "https://api.jolpi.ca/ergast/f1";

const MASTER_TRACK_BASE =
  "https://raw.githubusercontent.com/MasterPlay007/F1-Track-Layouts-SVG/main";

const ALT_TRACK_BASE =
  "https://raw.githubusercontent.com/julesr0y/f1-circuits-svg/main/circuits/minimal/white";

const ALT_TRACK_OUTLINE_BASE =
  "https://raw.githubusercontent.com/julesr0y/f1-circuits-svg/main/circuits/minimal/white-outline";

const CIRCUITS = [
  {
    id: "albert_park",
    apiIds: ["albert_park"],
    name: "Albert Park",
    fullName: "Albert Park Grand Prix Circuit",
    city: "Melbourne",
    country: "Australia",
    flag: "🇦🇺",
    season: "2026",
    badge: "2026",
    length: "5.278 km",
    laps: 58,
    distance: "306.124 km",
    corners: 14,
    firstGp: 1996,
    accent: "#006847",
    accent2: "#ffcd00",
    trackFile: "albert_park.svg",
    description:
      "Un trazado semiurbano muy rápido alrededor de Albert Park. Combina curvas fluidas, frenadas fuertes y varias zonas donde los pilotos pueden atacar.",
  },
  {
    id: "shanghai",
    apiIds: ["shanghai"],
    name: "Shanghai",
    fullName: "Shanghai International Circuit",
    city: "Shanghái",
    country: "China",
    flag: "🇨🇳",
    season: "2026",
    badge: "2026",
    length: "5.451 km",
    laps: 56,
    distance: "305.066 km",
    corners: 16,
    firstGp: 2004,
    accent: "#de2910",
    accent2: "#ffde00",
    trackFile: "shanghai.svg",
    description:
      "Famoso por sus dos primeras curvas que se cierran progresivamente y por una de las rectas más largas del calendario.",
  },
  {
    id: "suzuka",
    apiIds: ["suzuka"],
    name: "Suzuka",
    fullName: "Suzuka International Racing Course",
    city: "Suzuka",
    country: "Japón",
    flag: "🇯🇵",
    season: "2026",
    badge: "2026",
    length: "5.807 km",
    laps: 53,
    distance: "307.471 km",
    corners: 18,
    firstGp: 1987,
    accent: "#bc002d",
    accent2: "#ffffff",
    trackFile: "suzuka.svg",
    description:
      "Uno de los grandes circuitos de pilotos. Sus Esses, Degner, Spoon y 130R forman una vuelta técnica, rápida y extremadamente exigente.",
  },
  {
    id: "miami",
    apiIds: ["miami"],
    name: "Miami",
    fullName: "Miami International Autodrome",
    city: "Miami",
    country: "Estados Unidos",
    flag: "🇺🇸",
    season: "2026",
    badge: "2026",
    length: "5.412 km",
    laps: 57,
    distance: "308.326 km",
    corners: 19,
    firstGp: 2022,
    accent: "#b22234",
    accent2: "#3c3b6e",
    trackFile: "miami.svg",
    description:
      "Un circuito moderno alrededor del Hard Rock Stadium, con secciones muy rápidas combinadas con una zona técnica y lenta.",
  },
  {
    id: "villeneuve",
    apiIds: ["villeneuve"],
    name: "Montréal",
    fullName: "Circuit Gilles Villeneuve",
    city: "Montréal",
    country: "Canadá",
    flag: "🇨🇦",
    season: "2026",
    badge: "2026",
    length: "4.361 km",
    laps: 70,
    distance: "305.270 km",
    corners: 14,
    firstGp: 1978,
    accent: "#d80621",
    accent2: "#ffffff",
    trackFile: "villeneuve.svg",
    description:
      "Una pista de frenadas, chicanes y largas rectas. El famoso Muro de los Campeones espera cualquier pequeño error en la última chicane.",
  },
  {
    id: "monaco",
    apiIds: ["monaco"],
    name: "Monaco",
    fullName: "Circuit de Monaco",
    city: "Montecarlo",
    country: "Mónaco",
    flag: "🇲🇨",
    season: "2026",
    badge: "2026",
    length: "3.337 km",
    laps: 78,
    distance: "260.286 km",
    corners: 19,
    firstGp: 1950,
    accent: "#ce1126",
    accent2: "#ffffff",
    trackFile: "monaco.svg",
    description:
      "El circuito urbano por excelencia. Estrecho, lento y sin margen de error, donde la clasificación y la precisión son fundamentales.",
  },
  {
    id: "catalunya",
    apiIds: ["catalunya"],
    name: "Barcelona-Catalunya",
    fullName: "Circuit de Barcelona-Catalunya",
    city: "Barcelona",
    country: "España",
    flag: "🇪🇸",
    season: "2026",
    badge: "2026",
    length: "4.657 km",
    laps: 66,
    distance: "307.236 km",
    corners: 14,
    firstGp: 1991,
    accent: "#aa151b",
    accent2: "#f1bf00",
    trackFile: "catalunya.svg",
    description:
      "Un circuito muy completo que pone a prueba prácticamente todos los aspectos de un monoplaza, desde carga aerodinámica hasta gestión de neumáticos.",
  },
  {
    id: "red_bull_ring",
    apiIds: ["red_bull_ring"],
    name: "Red Bull Ring",
    fullName: "Red Bull Ring",
    city: "Spielberg",
    country: "Austria",
    flag: "🇦🇹",
    season: "2026",
    badge: "2026",
    length: "4.326 km",
    laps: 71,
    distance: "307.026 km",
    corners: 10,
    firstGp: 1970,
    accent: "#ed2939",
    accent2: "#ffffff",
    trackFile: "red_bull_ring.svg",
    description:
      "Una vuelta corta y explosiva con fuertes desniveles. Sus pocas curvas hacen que las diferencias sean mínimas y cada error cueste mucho.",
  },
  {
    id: "silverstone",
    apiIds: ["silverstone"],
    name: "Silverstone",
    fullName: "Silverstone Circuit",
    city: "Silverstone",
    country: "Reino Unido",
    flag: "🇬🇧",
    season: "2026",
    badge: "2026",
    length: "5.891 km",
    laps: 52,
    distance: "306.198 km",
    corners: 18,
    firstGp: 1950,
    accent: "#012169",
    accent2: "#c8102e",
    trackFile: "silverstone.svg",
    description:
      "Una de las cunas de la Fórmula 1. Maggotts, Becketts y Chapel forman una de las secuencias de alta velocidad más espectaculares del campeonato.",
  },
  {
    id: "spa",
    apiIds: ["spa"],
    name: "Spa-Francorchamps",
    fullName: "Circuit de Spa-Francorchamps",
    city: "Spa",
    country: "Bélgica",
    flag: "🇧🇪",
    season: "2026",
    badge: "2026",
    length: "7.004 km",
    laps: 44,
    distance: "308.054 km",
    corners: 19,
    firstGp: 1950,
    accent: "#ffd90c",
    accent2: "#ef3340",
    trackFile: "spa.svg",
    description:
      "El circuito más largo del calendario actual. Eau Rouge, Raidillon, Pouhon y Blanchimont convierten una vuelta en Spa en una experiencia única.",
  },
  {
    id: "hungaroring",
    apiIds: ["hungaroring"],
    name: "Hungaroring",
    fullName: "Hungaroring",
    city: "Budapest",
    country: "Hungría",
    flag: "🇭🇺",
    season: "2026",
    badge: "2026",
    length: "4.381 km",
    laps: 70,
    distance: "306.630 km",
    corners: 14,
    firstGp: 1986,
    accent: "#436f4d",
    accent2: "#ce2939",
    trackFile: "hungaroring.svg",
    description:
      "Técnico y revirado, con muy poco descanso entre curvas. La continuidad y el ritmo son más importantes que la velocidad punta.",
  },
  {
    id: "zandvoort",
    apiIds: ["zandvoort"],
    name: "Zandvoort",
    fullName: "Circuit Zandvoort",
    city: "Zandvoort",
    country: "Países Bajos",
    flag: "🇳🇱",
    season: "2026",
    badge: "2026",
    length: "4.259 km",
    laps: 72,
    distance: "306.592 km",
    corners: 14,
    firstGp: 1952,
    accent: "#ae1c28",
    accent2: "#21468b",
    trackFile: "zandvoort.svg",
    description:
      "Compacto, rápido y con curvas peraltadas muy características. Su ubicación junto al Mar del Norte añade además el viento como variable.",
  },
  {
    id: "monza",
    apiIds: ["monza"],
    name: "Monza",
    fullName: "Autodromo Nazionale Monza",
    city: "Monza",
    country: "Italia",
    flag: "🇮🇹",
    season: "2026",
    badge: "2026",
    length: "5.793 km",
    laps: 53,
    distance: "306.720 km",
    corners: 11,
    firstGp: 1950,
    accent: "#009246",
    accent2: "#ce2b37",
    trackFile: "monza.svg",
    description:
      "El Templo de la Velocidad. Rectas enormes, muy poca carga aerodinámica y frenadas violentas hacen de Monza una pista única.",
  },
  {
    id: "madring",
    apiIds: ["madring", "madrid"],
    name: "Madring",
    fullName: "Madring",
    city: "Madrid",
    country: "España",
    flag: "🇪🇸",
    season: "2026",
    badge: "Nuevo 2026",
    length: "5.414 km",
    laps: 57,
    distance: "308.399 km",
    corners: 22,
    firstGp: 2026,
    accent: "#aa151b",
    accent2: "#f1bf00",
    altTracks: [
      "https://raw.githubusercontent.com/PadokBg/f1bulgaria/master/resources/svg/circuits/madring.svg",
      "https://raw.githubusercontent.com/drumandbytes/paddock-api/main/static/track_maps/madring.svg",
    ],
    description:
      "El nuevo escenario madrileño mezcla carretera urbana y secciones permanentes. Su elemento más espectacular es La Monumental, una larga curva peraltada.",
  },
  {
    id: "baku",
    apiIds: ["baku"],
    name: "Baku",
    fullName: "Baku City Circuit",
    city: "Bakú",
    country: "Azerbaiyán",
    flag: "🇦🇿",
    season: "2026",
    badge: "2026",
    length: "6.003 km",
    laps: 51,
    distance: "306.049 km",
    corners: 20,
    firstGp: 2016,
    accent: "#00b5e2",
    accent2: "#ef3340",
    trackFile: "baku.svg",
    description:
      "Un circuito urbano de extremos: la estrechísima zona del castillo contrasta con una recta final donde los F1 alcanzan velocidades enormes.",
  },
  {
    id: "sepang",
    apiIds: ["sepang"],
    name: "Sepang",
    fullName: "Sepang International Circuit",
    city: "Kuala Lumpur",
    country: "Malasia",
    flag: "🇲🇾",
    season: "2026",
    badge: "Especial 2026",
    length: "5.543 km",
    laps: 56,
    distance: "310.398 km",
    corners: 15,
    firstGp: 1999,
    accent: "#010066",
    accent2: "#cc0001",
    altTracks: [
      `${ALT_TRACK_BASE}/sepang-1.svg`,
      `${ALT_TRACK_OUTLINE_BASE}/sepang-1.svg`,
    ],
    description:
      "Sepang regresó de forma extraordinaria en 2026. Una pista ancha y exigente, famosa por su calor, humedad, fuertes frenadas y clima impredecible.",
  },
  {
    id: "marina_bay",
    apiIds: ["marina_bay"],
    name: "Marina Bay",
    fullName: "Marina Bay Street Circuit",
    city: "Singapur",
    country: "Singapur",
    flag: "🇸🇬",
    season: "2026",
    badge: "2026",
    length: "4.927 km",
    laps: 62,
    distance: "305.337 km",
    corners: 19,
    firstGp: 2008,
    accent: "#ef3340",
    accent2: "#ffffff",
    trackFile: "marina_bay.svg",
    description:
      "La primera carrera nocturna de la historia de la F1. Calor, humedad, muros y una duración elevada convierten Singapur en una prueba física brutal.",
  },
  {
    id: "americas",
    apiIds: ["americas"],
    name: "Circuit of the Americas",
    fullName: "Circuit of the Americas",
    city: "Austin",
    country: "Estados Unidos",
    flag: "🇺🇸",
    season: "2026",
    badge: "2026",
    length: "5.513 km",
    laps: 56,
    distance: "308.405 km",
    corners: 20,
    firstGp: 2012,
    accent: "#b22234",
    accent2: "#3c3b6e",
    trackFile: "americas.svg",
    description:
      "Una pista moderna inspirada en algunas de las mejores curvas del mundo, comenzando con la espectacular subida hacia la curva 1.",
  },
  {
    id: "rodriguez",
    apiIds: ["rodriguez"],
    name: "Hermanos Rodríguez",
    fullName: "Autódromo Hermanos Rodríguez",
    city: "Ciudad de México",
    country: "México",
    flag: "🇲🇽",
    season: "2026",
    badge: "2026",
    length: "4.304 km",
    laps: 71,
    distance: "305.354 km",
    corners: 17,
    firstGp: 1963,
    accent: "#006847",
    accent2: "#ce1126",
    trackFile: "rodriguez.svg",
    description:
      "La gran altitud de Ciudad de México reduce la densidad del aire y crea condiciones aerodinámicas muy particulares. El Foro Sol aporta una atmósfera incomparable.",
  },
  {
    id: "interlagos",
    apiIds: ["interlagos"],
    name: "Interlagos",
    fullName: "Autódromo José Carlos Pace",
    city: "São Paulo",
    country: "Brasil",
    flag: "🇧🇷",
    season: "2026",
    badge: "2026",
    length: "4.309 km",
    laps: 71,
    distance: "305.879 km",
    corners: 15,
    firstGp: 1973,
    accent: "#009c3b",
    accent2: "#ffdf00",
    trackFile: "interlagos.svg",
    description:
      "Corto, ondulado y en sentido antihorario. Interlagos ha producido innumerables carreras caóticas gracias a su diseño y a un clima capaz de cambiar rápidamente.",
  },
  {
    id: "vegas",
    apiIds: ["vegas", "las_vegas"],
    name: "Las Vegas",
    fullName: "Las Vegas Strip Circuit",
    city: "Las Vegas",
    country: "Estados Unidos",
    flag: "🇺🇸",
    season: "2026",
    badge: "2026",
    length: "6.201 km",
    laps: 50,
    distance: "309.958 km",
    corners: 17,
    firstGp: 2023,
    accent: "#b22234",
    accent2: "#3c3b6e",
    trackFile: "vegas.svg",
    description:
      "Un rapidísimo circuito nocturno por Las Vegas Strip. Las bajas temperaturas y las largas rectas complican especialmente la preparación de los neumáticos.",
  },
  {
    id: "losail",
    apiIds: ["losail"],
    name: "Lusail",
    fullName: "Lusail International Circuit",
    city: "Lusail",
    country: "Qatar",
    flag: "🇶🇦",
    season: "2026",
    badge: "2026",
    length: "5.419 km",
    laps: 57,
    distance: "308.611 km",
    corners: 16,
    firstGp: 2021,
    accent: "#8a1538",
    accent2: "#ffffff",
    trackFile: "losail.svg",
    description:
      "Un trazado de curvas medias y rápidas que exige mucha carga aerodinámica y castiga especialmente los neumáticos delanteros.",
  },
  {
    id: "yas_marina",
    apiIds: ["yas_marina"],
    name: "Yas Marina",
    fullName: "Yas Marina Circuit",
    city: "Abu Dhabi",
    country: "Emiratos Árabes Unidos",
    flag: "🇦🇪",
    season: "2026",
    badge: "2026",
    length: "5.281 km",
    laps: 58,
    distance: "306.188 km",
    corners: 16,
    firstGp: 2009,
    accent: "#ff0000",
    accent2: "#00732f",
    trackFile: "yas_marina.svg",
    description:
      "La tradicional final de temporada. La carrera comienza con luz natural y termina bajo los focos mientras cae la noche sobre Yas Island.",
  },
  {
    id: "portimao",
    apiIds: ["portimao", "algarve"],
    name: "Portimão",
    fullName: "Autódromo Internacional do Algarve",
    city: "Portimão",
    country: "Portugal",
    flag: "🇵🇹",
    season: "2027",
    badge: "Regresa 2027",
    length: "4.653 km",
    laps: 66,
    distance: "306.826 km",
    corners: 15,
    firstGp: 2020,
    accent: "#046a38",
    accent2: "#da291c",
    altTracks: [
      `${ALT_TRACK_BASE}/portimao-1.svg`,
      `${ALT_TRACK_OUTLINE_BASE}/portimao-1.svg`,
    ],
    description:
      "Una montaña rusa de asfalto. Sus fuertes cambios de elevación, curvas ciegas y desniveles convierten Portimão en uno de los circuitos más espectaculares visualmente.",
  },
  {
    id: "istanbul",
    apiIds: ["istanbul"],
    name: "Istanbul Park",
    fullName: "Istanbul Park",
    city: "Estambul",
    country: "Turquía",
    flag: "🇹🇷",
    season: "2027",
    badge: "Regresa 2027",
    length: "5.338 km",
    laps: 58,
    distance: "309.396 km",
    corners: 14,
    firstGp: 2005,
    accent: "#e30a17",
    accent2: "#ffffff",
    altTracks: [
      `${ALT_TRACK_BASE}/istanbul-1.svg`,
      `${ALT_TRACK_OUTLINE_BASE}/istanbul-1.svg`,
    ],
    description:
      "Conocido especialmente por la legendaria curva 8, una larguísima izquierda de múltiples vértices que pone a prueba neumáticos y cuello del piloto.",
  },
];

async function getJSON(url, retries = 2) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      lastError = error;

      if (attempt < retries) {
        await new Promise((resolve) =>
          setTimeout(resolve, 450 * (attempt + 1))
        );
      }
    }
  }

  throw lastError;
}

function extractRaces(data) {
  return data?.MRData?.RaceTable?.Races || [];
}

async function fetchPaginatedRaces(baseUrl) {
  const allRaces = [];
  let offset = 0;
  const limit = 100;

  for (let page = 0; page < 20; page += 1) {
    const separator = baseUrl.includes("?") ? "&" : "?";
    const data = await getJSON(
      `${baseUrl}${separator}limit=${limit}&offset=${offset}`
    );

    const races = extractRaces(data);
    allRaces.push(...races);

    const total = Number(data?.MRData?.total || allRaces.length);
    const returnedLimit = Number(data?.MRData?.limit || limit);

    if (races.length === 0 || offset + returnedLimit >= total) {
      break;
    }

    offset += returnedLimit;
  }

  return allRaces;
}

async function fetchForCircuit(circuit, endpointFactory) {
  let lastError = null;

  for (const apiId of circuit.apiIds) {
    try {
      const races = await fetchPaginatedRaces(
        endpointFactory(apiId)
      );

      if (races.length > 0) {
        return races;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return [];
}

function hexToRgba(hex, alpha = 1) {
  if (!hex?.startsWith("#")) {
    return `rgba(0, 245, 212, ${alpha})`;
  }

  const clean = hex.replace("#", "");
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);

  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function circuitStyle(circuit) {
  return {
    "--circuit-accent": circuit.accent,
    "--circuit-accent-2": circuit.accent2,
    "--circuit-soft": hexToRgba(circuit.accent, 0.07),
    "--circuit-soft-2": hexToRgba(circuit.accent, 0.14),
    "--circuit-medium": hexToRgba(circuit.accent, 0.25),
    "--circuit-border": hexToRgba(circuit.accent, 0.38),
    "--circuit-glow": hexToRgba(circuit.accent, 0.28),
    "--circuit-secondary-soft": hexToRgba(circuit.accent2, 0.1),
  };
}

function driverName(driver) {
  if (!driver) {
    return "—";
  }

  return `${driver.givenName} ${driver.familyName}`;
}

function parseLapTime(time) {
  if (!time) {
    return Infinity;
  }

  const parts = time.split(":");

  if (parts.length === 2) {
    return Number(parts[0]) * 60 + Number(parts[1]);
  }

  if (parts.length === 3) {
    return (
      Number(parts[0]) * 3600 +
      Number(parts[1]) * 60 +
      Number(parts[2])
    );
  }

  return Number(time);
}

function topDriver(rows, getDriver) {
  const map = new Map();

  rows.forEach((row) => {
    const driver = getDriver(row);

    if (!driver?.driverId) {
      return;
    }

    if (!map.has(driver.driverId)) {
      map.set(driver.driverId, {
        driver,
        count: 0,
      });
    }

    map.get(driver.driverId).count += 1;
  });

  const ordered = [...map.values()].sort(
    (a, b) => b.count - a.count
  );

  if (!ordered.length) {
    return null;
  }

  const highest = ordered[0].count;
  const tied = ordered.filter((item) => item.count === highest);

  return {
    count: highest,
    names: tied
      .map((item) => driverName(item.driver))
      .join(" / "),
  };
}

function raceKey(race) {
  return `${race.season}-${race.round}`;
}

function getWinnerRows(races) {
  return races
    .map((race) => {
      const winner = (race.Results || []).find(
        (result) => String(result.position) === "1"
      );

      if (!winner) {
        return null;
      }

      return {
        ...winner,
        race,
      };
    })
    .filter(Boolean);
}

function getFastestLapFromApi(races) {
  let fastestLap = null;

  races.forEach((race) => {
    (race.Results || []).forEach((result) => {
      const time = result.FastestLap?.Time?.time;

      if (!time) {
        return;
      }

      const seconds = parseLapTime(time);

      if (!fastestLap || seconds < fastestLap.seconds) {
        fastestLap = {
          seconds,
          time,
          driver: driverName(result.Driver),
          constructor: result.Constructor?.name,
          year: Number(race.season),
          lap: result.FastestLap?.lap,
        };
      }
    });
  });

  return fastestLap;
}

function getPoleRows(qualifyingRaces, gridRaces) {
  const polesByRace = new Map();

  gridRaces.forEach((race) => {
    const gridP1 = race.Results?.[0];

    if (!gridP1) {
      return;
    }

    polesByRace.set(raceKey(race), {
      ...gridP1,
      race,
      source: "grid",
    });
  });

  qualifyingRaces.forEach((race) => {
    const pole =
      (race.QualifyingResults || []).find(
        (result) => String(result.position) === "1"
      ) || race.QualifyingResults?.[0];

    if (!pole) {
      return;
    }

    polesByRace.set(raceKey(race), {
      ...pole,
      race,
      source: "qualifying",
    });
  });

  return [...polesByRace.values()];
}

async function fetchCircuitHistory(circuit) {
  const requests = await Promise.allSettled([
    fetchForCircuit(
      circuit,
      (apiId) => `${API}/circuits/${apiId}/results/1.json`
    ),
    fetchForCircuit(
      circuit,
      (apiId) => `${API}/circuits/${apiId}/fastest/1/results.json`
    ),
    fetchForCircuit(
      circuit,
      (apiId) => `${API}/circuits/${apiId}/qualifying/1.json`
    ),
    fetchForCircuit(
      circuit,
      (apiId) => `${API}/circuits/${apiId}/grid/1/results.json`
    ),
  ]);

  const winnerRaces =
    requests[0].status === "fulfilled" ? requests[0].value : [];
  const fastestLapRaces =
    requests[1].status === "fulfilled" ? requests[1].value : [];
  const qualifyingPoleRaces =
    requests[2].status === "fulfilled" ? requests[2].value : [];
  const gridPoleRaces =
    requests[3].status === "fulfilled" ? requests[3].value : [];

  const winnerRows = getWinnerRows(winnerRaces);
  const mostWins = topDriver(winnerRows, (row) => row.Driver);

  const latestWinnerRow = [...winnerRows].sort((a, b) => {
    const seasonDiff = Number(b.race.season) - Number(a.race.season);

    if (seasonDiff !== 0) {
      return seasonDiff;
    }

    return Number(b.race.round) - Number(a.race.round);
  })[0];

  const latestWinner = latestWinnerRow
    ? {
        driver: driverName(latestWinnerRow.Driver),
        constructor: latestWinnerRow.Constructor?.name,
        year: Number(latestWinnerRow.race.season),
      }
    : null;

  const poleRows = getPoleRows(
    qualifyingPoleRaces,
    gridPoleRaces
  );

  const mostPoles = topDriver(poleRows, (row) => row.Driver);
  const apiFastestLap = getFastestLapFromApi(fastestLapRaces);
  const manualRecord = getCircuitRecord(circuit.id);

  const lapRecord = manualRecord?.lapRecord
    ? {
        ...manualRecord.lapRecord,
        seconds: parseLapTime(manualRecord.lapRecord.time),
        source: "verified",
      }
    : apiFastestLap;

  return {
    mostWins: manualRecord?.mostWins || mostWins,
    mostPoles: manualRecord?.mostPoles || mostPoles,
    latestWinner,
    lapRecord,
    racesHeld: winnerRows.length || null,
    partial: requests.some((request) => request.status === "rejected"),
  };
}

function CircuitTrack({ circuit, expanded }) {
  const segmentedTrack = CIRCUIT_TRACKS[circuit.id];
  const hasSegmentedTrack =
    segmentedTrack?.type === "segmented" &&
    typeof segmentedTrack.viewBox === "string" &&
    ["s1", "s2", "s3"].every(
      (sector) => typeof segmentedTrack.sectors?.[sector] === "string"
    );

  const initialSources = useMemo(() => {
    const sources = [];

    if (circuit.trackFile) {
      sources.push(`${MASTER_TRACK_BASE}/${circuit.trackFile}`);
    }

    if (circuit.altTracks) {
      sources.push(...circuit.altTracks);
    }

    return sources;
  }, [circuit]);

  const [sourceIndex, setSourceIndex] = useState(0);
  const currentSource = initialSources[sourceIndex];

  if (hasSegmentedTrack) {
    return (
      <SegmentedCircuit
        circuitId={circuit.id}
        circuitName={circuit.name}
        cornerCount={circuit.corners}
        expanded={expanded}
        track={segmentedTrack}
      />
    );
  }

  if (!currentSource) {
    return (
      <div className="circuit-track-fallback-wrap">
        <svg
          className="circuit-track-fallback"
          viewBox="0 0 200 110"
          fill="none"
          aria-label="Trazado no disponible"
        >
          <path
            d="M20 72C40 22 70 22 82 48C94 75 110 87 132 69C151 54 143 26 167 25C185 24 188 51 172 64C153 79 126 78 111 91C94 104 72 92 61 76C49 58 36 82 20 72Z"
            stroke="currentColor"
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>

        <span className="circuit-track-fallback-text">
          Layout pending
        </span>
      </div>
    );
  }

  return (
    <img
      src={currentSource}
      className="circuit-track-image"
      alt={`Trazado de ${circuit.name}`}
      onError={() => setSourceIndex((current) => current + 1)}
    />
  );
}

function StaticStat({ label, value, sub }) {
  return (
    <div className="circuit-static-stat">
      <span>{label}</span>
      <strong>{value}</strong>
      {sub && <small>{sub}</small>}
    </div>
  );
}

function DynamicStat({ label, value, sub, loading }) {
  return (
    <div className="circuit-history-stat">
      <span>{label}</span>

      {loading ? (
        <>
          <div className="circuit-stat-skeleton large" />
          <div className="circuit-stat-skeleton small" />
        </>
      ) : (
        <>
          <strong className={!value ? "muted" : ""}>
            {value || "Dato no disponible"}
          </strong>

          <small>
            {sub || "No hay suficiente historial disponible."}
          </small>
        </>
      )}
    </div>
  );
}

function CircuitCard({ circuit, expanded, stats, onToggle }) {
  const historyLoading = stats?.loading === true;
  const history = stats?.data;

  return (
    <article
      className={`circuit-card ${expanded ? "expanded" : ""}`}
      style={circuitStyle(circuit)}
    >
      <div className="circuit-country-glow" />

      <button
        className="circuit-card-button"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <div className="circuit-card-heading">
          <div>
            <div className="circuit-country">
              <span>{circuit.flag}</span>
              {circuit.country}
            </div>

            <h2>{circuit.name}</h2>
            <p>
              {circuit.city} · {circuit.length}
            </p>
          </div>

          <div
            className={`circuit-season-badge ${
              circuit.season === "2027" ? "future" : ""
            }`}
          >
            {circuit.badge}
          </div>
        </div>

        <div className="circuit-track-stage">
          <CircuitTrack circuit={circuit} expanded={expanded} />
        </div>

        <div className="circuit-card-bottom">
          <div className="circuit-quick-stats">
            <span>
              <strong>{circuit.laps}</strong>
              vueltas
            </span>

            <span>
              <strong>{circuit.corners}</strong>
              curvas
            </span>
          </div>

          <div className="circuit-open-text">
            {expanded ? "Cerrar ↑" : "Explorar circuito →"}
          </div>
        </div>
      </button>

      <div className="circuit-expansion">
        <div className="circuit-expansion-inner">
          <div className="circuit-expanded-line" />

          <div className="circuit-expanded-header">
            <div>
              <div className="circuit-detail-eyebrow">
                {circuit.flag} {circuit.country}
              </div>
              <h3>{circuit.fullName}</h3>
            </div>

            <div className="circuit-first-gp">
              <span>Primer GP</span>
              <strong>{circuit.firstGp}</strong>
            </div>
          </div>

          <p className="circuit-description">{circuit.description}</p>

          <div className="circuit-static-grid">
            <StaticStat label="Longitud" value={circuit.length} />
            <StaticStat label="Vueltas" value={circuit.laps} />
            <StaticStat label="Distancia" value={circuit.distance} />
            <StaticStat label="Curvas" value={circuit.corners} />
          </div>

          <div className="circuit-history-title">
            <div>
              <span>Historia y récords</span>
              <h4>Estadísticas del circuito</h4>
            </div>

            {history?.partial && (
              <small>
                Parte del historial dinámico no pudo cargarse, pero los datos
                verificados siguen disponibles.
              </small>
            )}
          </div>

          <div className="circuit-history-grid">
            <DynamicStat
              label="Récord de vuelta"
              loading={historyLoading}
              value={history?.lapRecord?.time}
              sub={
                history?.lapRecord
                  ? `${history.lapRecord.driver} · ${history.lapRecord.year}`
                  : null
              }
            />

            <DynamicStat
              label="Más victorias"
              loading={historyLoading}
              value={history?.mostWins?.names}
              sub={
                history?.mostWins
                  ? `${history.mostWins.count} victorias`
                  : null
              }
            />

            <DynamicStat
              label="Más poles"
              loading={historyLoading}
              value={history?.mostPoles?.names}
              sub={
                history?.mostPoles
                  ? `${history.mostPoles.count} poles`
                  : null
              }
            />

            <DynamicStat
              label="Último ganador"
              loading={historyLoading}
              value={history?.latestWinner?.driver}
              sub={
                history?.latestWinner
                  ? `${history.latestWinner.constructor} · ${history.latestWinner.year}`
                  : null
              }
            />

            <DynamicStat
              label="GP disputados"
              loading={historyLoading}
              value={
                history?.racesHeld ? String(history.racesHeld) : null
              }
              sub="Según el historial disponible"
            />
          </div>

          <div className="circuit-sector-area">
            <div className="circuit-sector-heading">
              <span>Sectores</span>
              <small>S1 · S2 · S3</small>
            </div>

            <div className="circuit-sector-bar">
              <div className="sector-one">S1</div>
              <div className="sector-two">S2</div>
              <div className="sector-three">S3</div>
            </div>

            <p>
              Los tres colores ya representan los sectores visualmente. Más
              adelante podemos dividir también el trazado SVG en los puntos
              reales de S1, S2 y S3 usando geometría de telemetría.
            </p>
          </div>

          <div className="circuit-data-note">
            Récord de vuelta: dato verificado localmente cuando existe en
            CircuitRecords.js. Victorias, poles, último ganador y número de GP:
            calculados desde el historial de Jolpica. Para poles se prioriza la
            clasificación y se completa el historial antiguo con la P1 de
            parrilla cuando es necesario.
          </div>
        </div>
      </div>
    </article>
  );
}

export default function Circuits() {
  const [expandedCircuit, setExpandedCircuit] = useState(null);
  const [filter, setFilter] = useState("all");
  const [statsByCircuit, setStatsByCircuit] = useState({});
  const requestsInProgress = useRef(new Set());

  const visibleCircuits = useMemo(() => {
    if (filter === "all") {
      return CIRCUITS;
    }

    return CIRCUITS.filter((circuit) => circuit.season === filter);
  }, [filter]);

  async function ensureCircuitStats(circuit) {
    if (
      statsByCircuit[circuit.id]?.data ||
      requestsInProgress.current.has(circuit.id)
    ) {
      return;
    }

    requestsInProgress.current.add(circuit.id);

    const manualRecord = getCircuitRecord(circuit.id);

    setStatsByCircuit((current) => ({
      ...current,
      [circuit.id]: {
        loading: true,
        error: false,
        data: manualRecord?.lapRecord
          ? {
              lapRecord: manualRecord.lapRecord,
              mostWins: null,
              mostPoles: null,
              latestWinner: null,
              racesHeld: null,
              partial: false,
            }
          : null,
      },
    }));

    try {
      const data = await fetchCircuitHistory(circuit);

      setStatsByCircuit((current) => ({
        ...current,
        [circuit.id]: {
          loading: false,
          error: false,
          data,
        },
      }));
    } catch (error) {
      console.error(
        `Error cargando estadísticas de ${circuit.name}:`,
        error
      );

      setStatsByCircuit((current) => ({
        ...current,
        [circuit.id]: {
          loading: false,
          error: true,
          data: current[circuit.id]?.data || {
            lapRecord: manualRecord?.lapRecord || null,
            mostWins: manualRecord?.mostWins || null,
            mostPoles: manualRecord?.mostPoles || null,
            latestWinner: null,
            racesHeld: null,
            partial: true,
          },
        },
      }));
    } finally {
      requestsInProgress.current.delete(circuit.id);
    }
  }

  function toggleCircuit(circuit) {
    if (expandedCircuit === circuit.id) {
      setExpandedCircuit(null);
      return;
    }

    setExpandedCircuit(circuit.id);
    ensureCircuitStats(circuit);
  }

  function changeFilter(nextFilter) {
    setFilter(nextFilter);
    setExpandedCircuit(null);
  }

  return (
    <main className="page circuits-page">
      <section className="circuits-hero">
        <div>
          <div className="eyebrow">GridPulse Tracks</div>

          <h1>
            Los escenarios
            <br />
            del campeonato.
          </h1>

          <p>
            Explora los circuitos utilizados en 2026 y los grandes regresos
            confirmados para 2027. Abre cualquier trazado para descubrir sus
            características, récords e historia.
          </p>
        </div>

        <div className="circuits-hero-number">
          <strong>{CIRCUITS.length}</strong>
          <span>circuitos</span>
        </div>
      </section>

      <div className="circuits-toolbar">
        <button
          className={filter === "all" ? "active" : ""}
          onClick={() => changeFilter("all")}
        >
          Todos
          <span>{CIRCUITS.length}</span>
        </button>

        <button
          className={filter === "2026" ? "active" : ""}
          onClick={() => changeFilter("2026")}
        >
          Temporada 2026
          <span>
            {CIRCUITS.filter((circuit) => circuit.season === "2026").length}
          </span>
        </button>

        <button
          className={filter === "2027" ? "active" : ""}
          onClick={() => changeFilter("2027")}
        >
          Regresan 2027
          <span>
            {CIRCUITS.filter((circuit) => circuit.season === "2027").length}
          </span>
        </button>
      </div>

      <div className="circuits-grid">
        {visibleCircuits.map((circuit) => (
          <CircuitCard
            key={circuit.id}
            circuit={circuit}
            expanded={expandedCircuit === circuit.id}
            stats={statsByCircuit[circuit.id]}
            onToggle={() => toggleCircuit(circuit)}
          />
        ))}
      </div>

      <div className="circuit-sources">
        Datos históricos dinámicos: Jolpica F1. Récords de vuelta: archivo
        local verificado CircuitRecords.js.         Trazados: MasterPlay007 F1 Track Layouts SVG, MisterSix2295
        f1-circuits-svg y fuentes SVG de Madring.
      </div>
    </main>
  );
}
