import {
  memo,
} from "react";

import "./CountryFlag.css";
import "./Performance.css";


const FLAG_BASE =
  "https://cdn.jsdelivr.net/npm/flag-icons@7.5.0/flags/4x3";


const COUNTRY_CODES = {
  Australia: "au",

  China: "cn",

  Japan: "jp",
  Japón: "jp",

  Bahrain: "bh",
  Baréin: "bh",

  "Saudi Arabia": "sa",
  "Arabia Saudita": "sa",

  USA: "us",
  "United States": "us",
  "Estados Unidos": "us",

  Canada: "ca",
  Canadá: "ca",

  Monaco: "mc",
  Mónaco: "mc",

  Spain: "es",
  España: "es",

  Austria: "at",

  UK: "gb",
  "United Kingdom": "gb",
  "Great Britain": "gb",
  "Reino Unido": "gb",

  Belgium: "be",
  Bélgica: "be",

  Hungary: "hu",
  Hungría: "hu",

  Netherlands: "nl",
  "Países Bajos": "nl",

  Italy: "it",
  Italia: "it",

  Azerbaijan: "az",
  Azerbaiyán: "az",

  Singapore: "sg",
  Singapur: "sg",

  Mexico: "mx",
  México: "mx",

  Brazil: "br",
  Brasil: "br",

  Qatar: "qa",

  UAE: "ae",
  "United Arab Emirates": "ae",
  "Emiratos Árabes Unidos": "ae",

  Malaysia: "my",
  Malasia: "my",

  Portugal: "pt",

  Turkey: "tr",
  Türkiye: "tr",
  Turquía: "tr",

  France: "fr",
  Francia: "fr",

  Germany: "de",
  Alemania: "de",

  Russia: "ru",
  Rusia: "ru",
};


function getCountryCode(
  country = ""
) {
  return (
    COUNTRY_CODES[
      country
    ] ||
    null
  );
}


function getFlagUrl(
  country
) {
  const code =
    getCountryCode(
      country
    );

  if (
    !code
  ) {
    return null;
  }

  return `${FLAG_BASE}/${code}.svg`;
}


export const CountryFlag =
  memo(
    function CountryFlag({
      country,
      className = "",
    }) {
      const src =
        getFlagUrl(
          country
        );


      if (
        !src
      ) {
        return (
          <span
            className={`country-flag-fallback ${className}`}
            aria-hidden="true"
          >
            🏁
          </span>
        );
      }


      return (
        <img
          src={src}
          alt={`Bandera de ${country}`}
          className={`country-flag ${className}`}
          draggable="false"
          loading="eager"
          decoding="async"
        />
      );
    }
  );


export const FlagBackground =
  memo(
    function FlagBackground({
      country,
      variant = "race",
    }) {
      const src =
        getFlagUrl(
          country
        );


      if (
        !src
      ) {
        return null;
      }


      const isCircuit =
        variant ===
        "circuit";


      return (
        <div
          className={`flag-background flag-background--${variant}`}
          aria-hidden="true"
        >
          <img
            src={src}
            alt=""
            className="flag-background-image"
            draggable="false"
            loading={
              isCircuit
                ? "lazy"
                : "eager"
            }
            decoding="async"
            fetchPriority={
              isCircuit
                ? "low"
                : "auto"
            }
          />
        </div>
      );
    }
  );