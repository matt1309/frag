cmake_minimum_required(VERSION 3.16)
project(frag-server VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# ── Options ───────────────────────────────────────────────────────────────────
option(FRAG_STATIC "Build statically linked binary" OFF)

if(FRAG_STATIC)
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -static")
endif()

# ── Dependencies ──────────────────────────────────────────────────────────────
include(FetchContent)

# SQLite3 amalgamation
find_package(PkgConfig QUIET)
if(PkgConfig_FOUND)
    pkg_check_modules(SQLite3 QUIET sqlite3)
endif()

if(SQLite3_FOUND)
    message(STATUS "Using system SQLite3: ${SQLite3_VERSION}")
    set(SQLITE3_LIBS    ${SQLite3_LIBRARIES})
    set(SQLITE3_INCDIRS ${SQLite3_INCLUDE_DIRS})
else()
    message(STATUS "System SQLite3 not found – fetching amalgamation...")
    FetchContent_Declare(
        sqlite3_src
        URL      https://www.sqlite.org/2024/sqlite-amalgamation-3450200.zip
        URL_HASH SHA256=df5c39f89c7f2dd94ab88c1d8a7d73d0e4916b60a68fcd1e51ee1f97dcd83e1a
        DOWNLOAD_EXTRACT_TIMESTAMP TRUE
    )
    FetchContent_MakeAvailable(sqlite3_src)
    add_library(sqlite3_bundled STATIC ${sqlite3_src_SOURCE_DIR}/sqlite3.c)
    target_compile_definitions(sqlite3_bundled PUBLIC
        SQLITE_THREADSAFE=1
        SQLITE_DEFAULT_WAL_SYNCHRONOUS=1)
    target_include_directories(sqlite3_bundled PUBLIC ${sqlite3_src_SOURCE_DIR})
    set(SQLITE3_LIBS    sqlite3_bundled)
    set(SQLITE3_INCDIRS "")
endif()

# ── Sources ───────────────────────────────────────────────────────────────────
set(SOURCES
    src/main.cpp
    src/server.cpp
    src/database.cpp
    src/handlers.cpp
)

add_executable(frag-server ${SOURCES})

target_include_directories(frag-server PRIVATE src ${SQLITE3_INCDIRS})
target_link_libraries(frag-server PRIVATE ${SQLITE3_LIBS})

if(WIN32)
    target_link_libraries(frag-server PRIVATE ws2_32)
endif()

# ── Compiler warnings ─────────────────────────────────────────────────────────
if(MSVC)
    target_compile_options(frag-server PRIVATE /W4 /WX)
else()
    target_compile_options(frag-server PRIVATE
        -Wall -Wextra -Wpedantic
        -Wno-unused-parameter
        -Wno-missing-field-initializers)
endif()

# ── Install ───────────────────────────────────────────────────────────────────
install(TARGETS frag-server DESTINATION bin)
install(FILES ${CMAKE_SOURCE_DIR}/../backend/config.example.json
        DESTINATION etc/frag RENAME config.json OPTIONAL)

# ── Summary ───────────────────────────────────────────────────────────────────
message(STATUS "")
message(STATUS "  frag-server ${PROJECT_VERSION}")
message(STATUS "  Build type : ${CMAKE_BUILD_TYPE}")
message(STATUS "  Install to : ${CMAKE_INSTALL_PREFIX}")
message(STATUS "")
