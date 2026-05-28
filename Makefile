.PHONY: all clean build-kiro

DIST := dist

all: build-kiro

clean:
	rm -rf $(DIST)

build-kiro:
	@bash src/kiro/build.sh
